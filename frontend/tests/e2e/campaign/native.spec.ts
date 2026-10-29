/**
 * Campaign spec: one arm64 stack (Docker on Apple Silicon) and one linux/amd64 stack,
 * run at the same time. Both run the same journeys; the GPU journeys only run where
 * the GPU exists, and the linux run does the flip UNDER LOAD (CPU start, download
 * mid-work, GPU takeover).
 *
 * Env: KIMA_UI_BASE_URL, KIMA_TEST_USERNAME, KIMA_TEST_PASSWORD (same as dogfood)
 *      KIMA_CAMPAIGN_ARCH=arm|linux  (selects the GPU paths)
 */
import { test, expect, request, type Browser, type Page } from "@playwright/test";
import { softwareWebGL } from "../fixtures/shared";
import { requireBaseUrl } from "../fixtures/target";

const ARCH = process.env.KIMA_CAMPAIGN_ARCH ?? "arm";
const BASE = requireBaseUrl();
const USER = process.env.KIMA_TEST_USERNAME!;
const PASS = process.env.KIMA_TEST_PASSWORD!;

test.describe.configure({ mode: "serial" });
// Headless Chromium has no GPU; the vibe map needs WebGL. Same fixture the
// dogfood and vibe suites use.
test.use(softwareWebGL);

const AUTH_STATE = "tests/e2e/.auth/user.json";

let token = "";
let api: Awaited<ReturnType<typeof request.newContext>>;

test.beforeAll(async () => {
    api = await request.newContext({ baseURL: BASE });
    const res = await api.post("/api/auth/login", { data: { username: USER, password: PASS } });
    expect(res.ok(), `login failed: ${res.status()}`).toBeTruthy();
    token = (await res.json()).token;
});
// Built per call: the token is only known after beforeAll runs.
const auth = () => ({ Authorization: `Bearer ${token}` });

/** Runs `journey` on a page that carries the signed-in state the global setup saved, then closes its context. */
async function asSignedIn(browser: Browser, journey: (page: Page) => Promise<void>): Promise<void> {
    const context = await browser.newContext({ storageState: AUTH_STATE });
    try {
        await journey(await context.newPage());
    } finally {
        await context.close();
    }
}

test.describe(`native campaign (${ARCH})`, () => {
    test("1. arrive: sign in and the library is there", async ({ page }) => {
        await page.goto(`${BASE}/login`);
        await page.locator("#username").fill(USER);
        await page.locator("#password").fill(PASS);
        await page.locator('button[type="submit"]').click();
        await expect(page).toHaveURL(/\/(home|library)?$|\/(home|library)/, { timeout: 30_000 });
        // The signed-in shell proves the session took.
        await expect(page.getByRole("link", { name: "Settings" })).toBeVisible({ timeout: 15_000 });
    });

    test("2. enrichment reaches every track (analysis + embeddings, platform-native)", async () => {
        test.setTimeout(150 * 60_000);
        // /api/enrichment/status is the pipeline's own summary. Settled means the
        // status is idle/complete and no track is in the analyzer; once settled,
        // no analysis may have failed (the gone-file rows live in TrackStage, not here).
        type EnrichmentStatus = {
            status?: string;
            audio?: { processing?: number; failed?: number };
        };
        const settled = (s: EnrichmentStatus | null) =>
            !!s && (s.status === "idle" || s.status === "complete") &&
            (s.audio?.processing ?? 0) === 0;
        let s: EnrichmentStatus | null = null;
        for (let i = 0; i < 140; i++) {
            const res = await api.get("/api/enrichment/status", { headers: auth() });
            if (res.ok()) s = await res.json();
            if (settled(s)) break;
            await new Promise((r) => setTimeout(r, 60_000));
        }
        expect(settled(s), `enrichment did not settle: ${JSON.stringify(s?.audio)}`).toBeTruthy();
        expect(s?.audio?.failed ?? 0, `tracks failed analysis: ${JSON.stringify(s?.audio)}`).toBe(0);
    });

    test("3. playback works end to end", async ({ browser }) => {
        test.setTimeout(2 * 60_000);
        await asSignedIn(browser, async (page) => {
            await page.goto(`${BASE}/collection`);
            // The collection page opens on its Artists tab; albums live behind the tab.
            const albumsTab = page.getByRole("button", { name: "Albums", exact: true });
            await albumsTab.waitFor({ state: "visible", timeout: 30_000 });
            await albumsTab.click();
            await page.waitForURL(/tab=albums/, { timeout: 10_000 });
            const cards = page.locator('main a[href^="/album/"]');
            await cards.first().waitFor({ state: "visible", timeout: 30_000 });
            await cards.first().click();
            await page.waitForURL(/\/album\//, { timeout: 10_000 });
            const rows = page.locator("[data-track-row]");
            await expect(rows.first()).toBeVisible({ timeout: 15_000 });
            await page.getByLabel("Play all").click();
            await page.getByTitle("pause", { exact: true }).waitFor({ timeout: 15_000 });
            const src = await page.evaluate(() => document.querySelector("audio")?.src ?? "");
            expect(src, "no audio source was set").toBeTruthy();
        });
    });

    test("4. vibe map renders and similar tracks returns neighbours", async ({ browser }) => {
        test.setTimeout(2 * 60_000);
        await asSignedIn(browser, async (page) => {
            await page.goto(`${BASE}/vibe`);
            await page.waitForURL(/\/vibe/, { timeout: 10_000 });
            const field = page.getByTestId("vibe-map-field");
            // If the lazy import did not resolve (order-dependent in this worker), reload once.
            const mapUp = await field.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
            if (!mapUp) {
                await page.reload();
                await page.waitForURL(/\/vibe/, { timeout: 10_000 });
            }
            await expect(field).toBeVisible({ timeout: 60_000 });
        });
        // The route needs a track: take the first track the library reports.
        const list = await api.get("/api/library/tracks?limit=1", { headers: auth() });
        expect(list.ok()).toBeTruthy();
        const trackId = (await list.json()).tracks[0]?.id;
        expect(trackId, "library returned no track to query neighbours for").toBeTruthy();
        const res = await api.get(`/api/vibe/similar/${trackId}?limit=5`, { headers: auth() });
        expect(res.ok()).toBeTruthy();
        const neighbours = (await res.json()).tracks;
        expect(neighbours.length > 0, "no neighbours returned").toBeTruthy();
    });

    if (ARCH === "linux") {
        test("5L. GPU flip under load (CPU start -> download mid-work -> GPU takeover)", async () => {
            test.setTimeout(90 * 60_000);
            // Preconditions: both switches off, work queued. Switching off keeps the GPU download, so the
            // download half runs only on a stack that has none on disk (gpu-onnx deleted); the takeover always runs.
            const st = await (await api.get("/api/system-settings/gpu", { headers: auth() })).json();
            expect(st.supported, "linux stack must report GPU supported").toBeTruthy();
            const downloads = !st.installed;
            if (!downloads) {
                test.info().annotations.push({ type: "not covered", description: "download mid-work: the GPU download was already on disk" });
            }

            if (st.enabled || st.analysis) {
                await api.post("/api/system-settings/gpu", {
                    headers: auth(),
                    data: { enabled: false, analysis: false },
                });
            }
            // Both analyzers must have restarted on the CPU, or the takeover below would read their old answer.
            await expect
                .poll(async () => {
                    const s = await (await api.get("/api/system-settings/gpu", { headers: auth() })).json();
                    return !s.providerActive && !s.analysisProviderActive;
                }, { timeout: 10 * 60_000, intervals: [5_000, 15_000] })
                .toBe(true);

            // Start the churn: force a vibe rebuild on CPU.
            const rb = await api.post("/api/analysis/vibe/start", { headers: auth(), data: { force: true } });
            expect(rb.ok()).toBeTruthy();

            // Wait until embeddings are actively working. The counter must come
            // from /progress (TrackStage rows), not /status (which only counts
            // the current scan run and stays zero for reopened backlog).
            await expect
                .poll(async () => {
                    const res = await api.get("/api/enrichment/progress", { headers: auth() });
                    if (!res.ok()) return 0;
                    const p = await res.json();
                    return p?.clapEmbeddings?.processing ?? 0;
                }, { timeout: 15 * 60_000, intervals: [5_000, 15_000, 15_000] })
                .toBeGreaterThan(0);

            // THE FLIP: both switches on while jobs are in flight.
            const flip = await api.post("/api/system-settings/gpu", {
                headers: auth(),
                data: { enabled: true, analysis: true },
            });
            expect(flip.ok()).toBeTruthy();

            // Download must be visible while work continues.
            if (downloads) {
                await expect
                    .poll(async () => (await (await api.get("/api/system-settings/gpu", { headers: auth() })).json()).installing, { timeout: 5 * 60_000 })
                    .toBe(true);
            }
            // ...and end installed with the GPU actually carrying work.
            await expect
                .poll(async () => {
                    const s = await (await api.get("/api/system-settings/gpu", { headers: auth() })).json();
                    return s.installed && s.effective && s.analysisEffective;
                }, { timeout: 30 * 60_000, intervals: [10_000, 30_000, 30_000] })
                .toBeTruthy();

            // The rebuild this test started finishes before the next test, which needs a finished library.
            await expect
                .poll(async () => {
                    const res = await api.get("/api/enrichment/progress", { headers: auth() });
                    return res.ok() && (await res.json()).isFullyComplete === true;
                }, { timeout: 30 * 60_000, intervals: [10_000, 30_000, 30_000], message: "the rebuild this test started never finished" })
                .toBe(true);
        });

        test("6L. both worker counts can be set to the CPU core count, and are put back", async () => {
            test.setTimeout(30 * 60_000);
            const before = await (await api.get("/api/analysis/clap-workers", { headers: auth() })).json();
            const beforeA = await (await api.get("/api/analysis/workers", { headers: auth() })).json();
            try {
                const maxed = await (await api.put("/api/analysis/clap-workers", { headers: auth(), data: { workers: before.cpuCores } })).json();
                expect(maxed.workers).toBe(before.cpuCores);
                const maxedA = await (await api.put("/api/analysis/workers", { headers: auth(), data: { workers: before.cpuCores } })).json();
                expect(maxedA.workers).toBe(before.cpuCores);
            } finally {
                await api.put("/api/analysis/clap-workers", { headers: auth(), data: { workers: before.workers } });
                await api.put("/api/analysis/workers", { headers: auth(), data: { workers: beforeA.workers } });
            }
        });
    } else {
        test("5A. arm: GPU switches are not offered (no CUDA on this host)", async () => {
            const st = await (await api.get("/api/system-settings/gpu", { headers: auth() })).json();
            expect(st.supported).toBeFalsy();
            const res = await api.post("/api/system-settings/gpu", { headers: auth(), data: { enabled: true } });
            expect(res.status()).toBe(400);
        });
    }
});
