import { execFileSync, spawnSync } from "node:child_process";
import { test, expect, APIRequestContext } from "@playwright/test";
import { requireBaseUrl } from "../fixtures/target";
import { stackSql } from "../fixtures/stackDb";

/**
 * Enrichment runs in order on the real stack, measured from the analyzers' own logs and the stage records:
 *
 * - a library scan comes first: "run enrichment now" during a scan is turned down;
 * - audio analysis (MusiCNN) and sound vectors (CLAP) never run at the same time; each finishes its run before the
 *   other starts, and an album added during either run waits its turn;
 * - every song is analysed once and given its sound vector once, also across an analyzer restart in the middle of
 *   analysis, which loses no time;
 * - the moods and the vibe map come once, after the last sound vector.
 *
 * It re-runs enrichment from audio analysis and needs an admin, so it runs only on a throwaway stack (KIMA_CONTAINER names its all-in-one
 * container, whose /music it adds two albums to and removes them from again).
 */

const baseUrl = requireBaseUrl();
const container = process.env.KIMA_CONTAINER ?? "";
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";
const ADDED = "/music/_e2e_enrichment_flow";

const MUSICNN_DONE = /audio-analyzer - INFO - ✓ Completed: (.+)$/;
const CLAP_DONE = /clap-analyzer - INFO - \[BullMQ\] Completed vibe for track: (\S+)/;
const MAP_LAID_OUT = /Vibe map laid out: \d+ tracks/;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
const inStack = (cmd: string) => docker("exec", container, "sh", "-c", cmd).trim();

interface LogLine {
    at: number;
    text: string;
}

/** The container's log since `since`, both streams (the analyzers write to stderr), each line with Docker's own
 * timestamp, in time order. */
function logSince(since: Date): LogLine[] {
    const out = spawnSync("docker", ["logs", "-t", "--since", since.toISOString(), container], {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 256 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(`docker logs failed: ${out.stderr.slice(0, 300)}`);
    return `${out.stdout}\n${out.stderr}`
        .split("\n")
        .map((line) => {
            const space = line.indexOf(" ");
            return { at: Date.parse(line.slice(0, space)), text: line.slice(space + 1) };
        })
        .filter((l) => Number.isFinite(l.at))
        .sort((a, b) => a.at - b.at);
}

/** Each analyzer's completions, in order, with what they finished. */
function completions(lines: LogLine[]) {
    const out: Array<{ at: number; model: "musicnn" | "clap"; what: string }> = [];
    for (const l of lines) {
        const m = MUSICNN_DONE.exec(l.text);
        if (m) out.push({ at: l.at, model: "musicnn", what: m[1] });
        const c = CLAP_DONE.exec(l.text);
        if (c) out.push({ at: l.at, model: "clap", what: c[1] });
    }
    return out;
}

async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs: number, everyMs = 5_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, everyMs));
    }
    throw new Error(`timed out waiting for ${what}`);
}

test.describe.configure({ mode: "serial" });

test("enrichment: scan first, one heavy model at a time, each song once, moods and map last", async ({ playwright }) => {
    test.skip(!container, "KIMA_CONTAINER is not set: this re-runs enrichment and changes /music, so only on a named throwaway stack");
    // Checked before anything changes: a read-only music folder (a stack that mounts someone's own music) cannot take
    // the added albums, and the re-run must not start without them.
    const writable = container ? inStack(`test -w /music && echo yes || echo no`) === "yes" : false;
    test.skip(!writable, "the stack's /music is read-only, so no album can be added mid-run");
    expect(username && password, "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set").toBeTruthy();
    test.setTimeout(240 * 60_000);

    const api: APIRequestContext = await playwright.request.newContext({ baseURL: baseUrl });
    const login = await api.post("/api/auth/login", { data: { username, password } });
    expect(login.status()).toBe(200);
    const headers = { Authorization: `Bearer ${(await login.json()).token}` };
    const call = async (method: "GET" | "POST" | "PUT", path: string, data?: object) => {
        const res =
            method === "GET" ? await api.get(path, { headers }) : await api.fetch(path, { method, headers, data: data ?? {} });
        expect(res.status(), `${method} ${path}`).toBeLessThan(300);
        return res.json();
    };
    expect((await call("GET", "/api/auth/me")).role, "the test user must be an admin: it re-runs enrichment").toBe("admin");
    expect((await call("GET", "/api/analysis/together")).together, "'run both at once' must be off").toBe(false);
    const complete = async () => (await call("GET", "/api/enrichment/progress")).isFullyComplete === true;
    const count = (sql: string) => Number(stackSql(sql));
    /** The container's clock, the one Docker stamps its log lines with. */
    const stackNow = () => Number(inStack("date +%s%3N"));
    const songsUnder = (name: string) => count(`SELECT count(*) FROM "Track" WHERE starts_with("filePath", '_e2e_enrichment_flow/${name}/') AND "missingSince" IS NULL`);
    const LIBRARY = `FROM "Track" t JOIN "Album" a ON a.id = t."albumId" WHERE a.location = 'LIBRARY' AND t."missingSince" IS NULL AND NOT t.corrupt`;
    // Two albums of the library, copied (hard links, no extra disk) under a folder this test owns.
    const albums = inStack(
        `find /music -mindepth 2 -maxdepth 2 -type d ! -path '${ADDED}*' | while read d; do n=$(find "$d" -maxdepth 1 -type f \\( -name '*.flac' -o -name '*.mp3' -o -name '*.m4a' -o -name '*.ogg' \\) | wc -l); [ "$n" -ge 3 ] && [ "$n" -le 15 ] && echo "$d"; done | head -2`,
    ).split("\n");
    expect(albums, "the library needs two albums of 3-15 songs").toHaveLength(2);
    /** Copy an album in, scan, and wait until the scan has added its songs. */
    const addAlbum = async (album: string, name: string) => {
        inStack(`mkdir -p ${ADDED} && cp -al "${album}" "${ADDED}/${name}"`);
        const files = Number(inStack(`find "${ADDED}/${name}" -maxdepth 1 -type f \\( -name '*.flac' -o -name '*.mp3' -o -name '*.m4a' -o -name '*.ogg' \\) | wc -l`));
        await call("POST", "/api/library/scan");
        return files;
    };
    const scanned = (name: string, files: number) => waitFor(`the scan to add ${name}`, () => songsUnder(name) === files, 10 * 60_000, 1_000);

    // Every 5 s through the run: MusiCNN and CLAP must never both hold work (stage records in flight).
    const overlaps: string[] = [];
    let sampling = true;
    const sampler = (async () => {
        while (sampling) {
            try {
                const [analysing, embedding] = (stackSql(
                    `SELECT count(*) FILTER (WHERE stage = 'analysis'), count(*) FILTER (WHERE stage = 'embedding') FROM "TrackStage" WHERE status = 'working'`,
                ) ?? "0|0").split("|").map(Number);
                if (analysing > 0 && embedding > 0) overlaps.push(`${new Date().toISOString()}: ${analysing} analysing, ${embedding} embedding`);
            } catch (error) {
                console.warn(`overlap sample skipped: ${(error as Error).message.slice(0, 200)}`);
            }
            await new Promise((r) => setTimeout(r, 5_000));
        }
    })();

    try {
        await waitFor("enrichment to be complete before the run", complete, 60 * 60_000, 15_000);
        const library = count(`SELECT count(*) ${LIBRARY}`);
        const started = new Date();
        const analysed = () => completions(logSince(started)).filter((c) => c.model === "musicnn").length;

        await test.step("re-run from audio analysis", async () => {
            await call("POST", "/api/enrichment/rerun", { step: "analysis" });
        });

        await test.step("an album added while audio analysis runs; 'run now' during its scan is turned down", async () => {
            await waitFor("MusiCNN to be under way", () => analysed() >= Math.min(20, Math.floor(library / 10)), 30 * 60_000);
            const files = await addAlbum(albums[0], "during-musicnn");
            const answers: string[] = [];
            for (let i = 0; i < 30 && !answers.includes("scan-running"); i++) {
                answers.push(String((await call("POST", "/api/enrichment/sync")).result?.declined));
                await new Promise((r) => setTimeout(r, 200));
            }
            expect(answers, "'run enrichment now' during a scan was never turned down for the scan").toContain("scan-running");
            await scanned("during-musicnn", files);
        });

        let restartedAt = 0;
        await test.step("the audio analyzer restarts in the middle of its run", async () => {
            await waitFor("MusiCNN to be well under way", () => analysed() >= Math.min(60, Math.floor(library / 4)), 30 * 60_000);
            restartedAt = stackNow();
            inStack("supervisorctl restart audio-analyzer");
        });

        let secondAlbumAt = 0;
        await test.step("an album added while sound vectors are made", async () => {
            await waitFor("CLAP to start", () => completions(logSince(started)).some((c) => c.model === "clap"), 90 * 60_000, 2_000);
            const files = await addAlbum(albums[1], "during-clap");
            await scanned("during-clap", files);
            secondAlbumAt = stackNow();
        });

        await test.step("enrichment finishes", async () => {
            await waitFor("enrichment to finish", complete, 120 * 60_000, 15_000);
        });

        sampling = false;
        await sampler;
        const lines = logSince(started);
        const done = completions(lines);
        const musicnn = done.filter((c) => c.model === "musicnn");
        const clap = done.filter((c) => c.model === "clap");

        await test.step("MusiCNN and CLAP never ran at once: whole runs, in turn", async () => {
            expect(overlaps, "moments both models held work").toEqual([]);
            // Consecutive completions of one model are one run; at once, the two would interleave.
            const runs = done.reduce<Array<{ model: string; last: number }>>(
                (r, c) => (r.at(-1)?.model === c.model ? [...r.slice(0, -1), { model: c.model, last: c.at }] : [...r, { model: c.model, last: c.at }]),
                [],
            );
            expect(runs.map((r) => r.model), "runs in order").toEqual(["musicnn", "clap", "musicnn", "clap"]);
            expect(runs[1].last, "the second album must arrive while CLAP's first run is still going").toBeGreaterThan(secondAlbumAt);
        });

        await test.step("every song analysed once and given its sound vector once", async () => {
            const twice = (items: string[]) => [...new Set(items.filter((x, i) => items.indexOf(x) !== i))];
            expect(twice(musicnn.map((c) => c.what)), "songs MusiCNN analysed more than once").toEqual([]);
            expect(twice(clap.map((c) => c.what)), "songs CLAP embedded more than once").toEqual([]);
            const answered = (stage: string) =>
                count(`SELECT count(*) ${LIBRARY} AND EXISTS (SELECT 1 FROM "TrackStage" s WHERE s."trackId" = t.id AND s.stage = '${stage}' AND s.status = 'done')`);
            expect(musicnn.length, "MusiCNN completions against the songs it answered").toBe(answered("analysis"));
            expect(clap.length, "CLAP completions against the songs it answered").toBe(answered("embedding"));
            // The re-run starts every record's redelivery count at 0, so any count now was a claim lost in this run.
            expect(count(`SELECT count(*) FROM "TrackStage" WHERE stage IN ('analysis', 'embedding') AND redelivered > 0`), "claims handed out again after being lost").toBe(0);
        });

        await test.step("the analyzer restart lost no time", async () => {
            const next = musicnn.find((c) => c.at > restartedAt);
            expect(next, "no song was analysed after the restart").toBeTruthy();
            expect(next!.at - restartedAt, "time from the restart to the next analysed song").toBeLessThan(3 * 60_000);
        });

        await test.step("the moods and the map came once, after the last sound vector", async () => {
            const lastVector = clap.at(-1)!.at;
            const maps = lines.filter((l) => MAP_LAID_OUT.test(l.text));
            expect(maps, "vibe map layouts during the run").toHaveLength(1);
            expect(maps[0].at).toBeGreaterThan(lastVector);
            const computed = count(`SELECT extract(epoch FROM computed_at) * 1000 FROM mood_state WHERE id = 'default'`);
            expect(computed, "mood statistics computed before the last sound vector").toBeGreaterThan(lastVector);
        });
    } finally {
        sampling = false;
        await sampler;
        // The added albums go: a song missing from two scans in a row is removed, so scan until none is left, then let
        // enrichment settle for the specs after this one.
        inStack(`rm -rf ${ADDED}`);
        for (let i = 0; i < 6 && count(`SELECT count(*) FROM "Track" WHERE starts_with("filePath", '_e2e_enrichment_flow/')`) > 0; i++) {
            await call("POST", "/api/library/scan").catch(() => {});
            await new Promise((r) => setTimeout(r, 30_000));
        }
        const left = count(`SELECT count(*) FROM "Track" WHERE starts_with("filePath", '_e2e_enrichment_flow/')`);
        // A failure earlier in the test stays the one reported; the leftover is said either way.
        if (left > 0) console.error(`${left} added songs were not removed from the library`);
        if (test.info().errors.length === 0) expect(left, "the added songs were not removed").toBe(0);
        await waitFor("enrichment to settle after the clean-up", complete, 30 * 60_000, 15_000);
        await api.dispose();
    }
});
