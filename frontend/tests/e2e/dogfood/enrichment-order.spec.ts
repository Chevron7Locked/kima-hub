import { test, expect } from "@playwright/test";
import { DogfoodSession } from "./session";
import { requireBaseUrl } from "../fixtures/target";
import { stackCreatedAt, stackLog, stackSql } from "../fixtures/stackDb";
import { completions, findOrderBreaks, parseDockerLog, parseStageRows, STAGE_ROWS_SQL } from "../fixtures/enrichmentOrder";

/**
 * Runs last in the release gate, on the stack the whole suite ran against, before anything replaces its container.
 * It reads the container's whole log, from the fresh install through every re-run the other specs set off, and every
 * song's stage records, and fails on any break of the enrichment order: identification after fingerprint, a vector after its
 * analysis, MusiCNN and CLAP never at once, one analysis and one vector per song and run, and the map laid out after
 * the last vector and never in the middle of a vector run. Moods are not checked on their own. That the library scan
 * finished first is not checked: nothing logs it at INFO level and the job queue keeps only the latest scan job, so
 * there is no evidence to read. What each rule reads and cannot see is in `fixtures/enrichmentOrder.ts`.
 */

const baseUrl = requireBaseUrl();
const container = process.env.KIMA_CONTAINER ?? "";
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";

test("enrichment order over the whole gate run: nothing out of order since the container started", async ({ playwright, page }) => {
    if (!container) {
        const reason = "enrichment order: KIMA_CONTAINER is not set, so the container's log and the stage records cannot be read";
        const session = new DogfoodSession(page, baseUrl);
        session.noteNotCovered(reason);
        session.writeReport("test-results/enrichment-order");
        test.skip(true, `not covered: ${reason}`);
    }
    expect(username && password, "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set").toBeTruthy();
    test.setTimeout(60 * 60_000);

    const api = await playwright.request.newContext({ baseURL: baseUrl });
    try {
        const login = await api.post("/api/auth/login", { data: { username, password } });
        expect(login.status()).toBe(200);
        const headers = { Authorization: `Bearer ${(await login.json()).token}` };
        const get = async (path: string) => {
            const res = await api.get(path, { headers });
            expect(res.status(), `GET ${path}`).toBe(200);
            return res.json();
        };
        // The setting that turns the one-at-a-time rule off; the gate must not run with it on.
        expect((await get("/api/analysis/together")).together, "'run both at once' must be off").toBe(false);

        // Enrichment a late journey set off must finish, or its log would end mid-run.
        const end = Date.now() + 30 * 60_000;
        while ((await get("/api/enrichment/progress")).isFullyComplete !== true) {
            expect(Date.now(), "enrichment did not finish within 30 minutes").toBeLessThan(end);
            await new Promise((r) => setTimeout(r, 15_000));
        }

        const lines = parseDockerLog(stackLog());
        const containerCreatedAt = stackCreatedAt();
        const stageRows = parseStageRows(stackSql(STAGE_ROWS_SQL) ?? "");
        console.log(`[enrichment-order] ${lines.length} log lines, ${completions(lines).length} analysis and vector completions, ${stageRows.length} stage rows`);
        expect(findOrderBreaks({ lines, stageRows, containerCreatedAt }), "enrichment order breaks").toEqual([]);
    } finally {
        await api.dispose();
    }
});
