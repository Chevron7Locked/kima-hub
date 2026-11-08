import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { completions, findOrderBreaks, mapLayouts, parseDockerLog, parseStageRows, type StageRow } from "../e2e/fixtures/enrichmentOrder";

const fixture = (name: string) => readFileSync(path.join(__dirname, "fixtures", "enrichmentOrder", name), "utf8");
const lines = (name: string) => fixture(name).split("\n").filter(Boolean);
const check = (log: string[]) =>
    findOrderBreaks({ lines: parseDockerLog(log.join("\n")), stageRows: parseStageRows(fixture("arm-stage-rows.txt")) });

describe("each song is analysed once within one analysis run", () => {
    it("passes the first install of the ARM stack", () => {
        expect(check(lines("arm-first-install.log"))).toEqual([]);
    });

    it("fails when a song is analysed a second time in the same run", () => {
        const log = lines("arm-first-install.log");
        const first = log.findIndex((l) => l.includes("✓ Completed: Artist A/Album 1/02.flac"));
        log.splice(first + 1, 0, log[first].replace(/^\S+/, "2026-11-07T18:38:46.000000000Z"));
        const breaks = check(log);
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(/analysed 2 times in one run.*Artist A\/Album 1\/02\.flac/);
    });
});

describe("each song gets its sound vector once within one vector run", () => {
    it("fails when a song is given a vector a second time in the same run", () => {
        const log = lines("arm-first-install.log");
        const first = log.findIndex((l) => l.includes("Completed vibe for track:"));
        log.splice(first + 1, 0, log[first].replace(/^\S+/, "2026-11-07T18:41:03.000000000Z"));
        const id = /track: (\S+)/.exec(log[first])![1];
        const breaks = check(log);
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(new RegExp(`got a sound vector 2 times in one run: ${id}`));
    });

    it("counts the 'force reset' of the vectors as the start of a new run, and nothing else", () => {
        const log = lines("arm-first-install.log");
        expect(check(log)).toEqual([]);
        // Without the reset line the same songs are vectored twice in one run.
        const without = log.filter((l) => !l.includes("owed vibe embedding (force reset)"));
        expect(without.length).toBe(log.length - 1);
        expect(check(without).length).toBeGreaterThan(0);
    });
});

describe("MusiCNN and CLAP never hold work at the same time", () => {
    it("fails when a song finishes analysis while a sound vector is being made", () => {
        const log = lines("amd-album-added.log");
        const start = log.findIndex((l) => l.includes("Processing vibe for track:"));
        const end = log.findIndex((l, i) => i > start && l.includes("Completed vibe for track:"));
        const [stamp] = log[end].split(" ");
        const midway = log[end].replace(/^\S+/, new Date(Date.parse(stamp) - 1).toISOString());
        const analysis = log.find((l) => l.includes("✓ Completed: Artist A/Album 1/05.flac"))!;
        log.splice(end, 0, analysis.replace(/^\S+/, midway.split(" ")[0]));
        const breaks = check(log);
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(/MusiCNN finished Artist A\/Album 1\/05\.flac while 2 sound vector\(s\) were being made/);
    });

    it("passes the amd64 run, where the album added during analysis waits for the vectors to finish", () => {
        expect(check(lines("amd-album-added.log"))).toEqual([]);
    });
});

describe("a sound vector job that ends without a completion is no longer in flight", () => {
    // The amd64 log: two vectors start together, then both complete, then MusiCNN finishes songs. Each test turns
    // the first completion into another ending of the same job, so the vector never completes but is not running.
    const endedWith = (ending: (id: string) => string, level = "INFO") => {
        const log = lines("amd-album-added.log");
        const done = log.findIndex((l) => l.includes("Completed vibe for track:"));
        const id = /track: (\S+)/.exec(log[done])![1];
        log[done] = log[done].replace(/INFO - \[BullMQ\] Completed vibe.*$/, `${level} - ${ending(id)}`);
        return { log, id };
    };

    it("passes when the claim was re-issued while the vector ran ('Not stored')", () => {
        const { log } = endedWith((id) => `[BullMQ] Not stored for ${id}: claim track-${id}-embedding-1-r0 was re-issued while it ran`);
        expect(check(log)).toEqual([]);
    });

    it("passes when the analyzer reported the vector failed ('Track X failed')", () => {
        const { log } = endedWith((id) => `Track ${id} failed: Failed to generate embedding`, "ERROR");
        expect(check(log)).toEqual([]);
    });

    it("passes when the worker reported the job failed ('Job <id> failed')", () => {
        const { log } = endedWith((id) => `[BullMQ] Job track-${id}-embedding-1-r0 failed: Embedding generation failed`, "ERROR");
        expect(check(log)).toEqual([]);
    });

    it("passes when the analyzer restarted with the vector running ('BullMQVibeWorker starting...')", () => {
        const log = lines("amd-album-added.log");
        const done = log.findIndex((l) => l.includes("Completed vibe for track:"));
        const restart = log[done].replace(/INFO - \[BullMQ\] Completed vibe.*$/, "INFO - BullMQVibeWorker starting...");
        log.splice(done, 1, restart, restart.replace("BullMQVibeWorker starting...", "[BullMQ] Worker started with concurrency 2"));
        // Both vectors were running at the restart; the second one's completion is dropped with the first's.
        const second = log.findIndex((l) => l.includes("Completed vibe for track:"));
        log.splice(second, 1);
        expect(check(log)).toEqual([]);
    });

    it("still fails when MusiCNN finishes a song while a different vector is running", () => {
        const { log } = endedWith((id) => `Track ${id} failed: Failed to generate embedding`, "ERROR");
        const other = log.findIndex((l) => l.includes("Completed vibe for track:"));
        log.splice(other, 1);
        const breaks = check(log);
        expect(breaks[0]).toMatch(/MusiCNN finished .* while 1 sound vector\(s\) were being made/);
    });

    it("does not end a running vector when another one starts (CLAP runs several at once)", () => {
        const log = lines("amd-album-added.log");
        const done = log.findIndex((l) => l.includes("Completed vibe for track:"));
        log.splice(done, 1);
        log.splice(done, 1);
        expect(check(log)[0]).toMatch(/while 2 sound vector\(s\) were being made/);
    });
});

describe("the vibe map is laid out after the last sound vector", () => {
    it("fails when the last vector run is not followed by a layout", () => {
        const log = lines("arm-first-install.log");
        const last = log.map((l) => l.includes("Vibe map laid out")).lastIndexOf(true);
        log.splice(last, 1);
        const breaks = check(log);
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(/sound vector made at .* has no vibe map layout after it/);
    });

    it("fails when a sound vector is made after the latest layout", () => {
        const log = lines("amd-album-added.log");
        const layout = log.findIndex((l) => l.includes("Vibe map laid out"));
        // The layout now comes before the four vectors of the album added mid-run, which end the log's vectors.
        log[layout] = log[layout].replace(/^\S+/, "2026-11-07T19:33:39.000000000Z");
        const breaks = check(log);
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(/has no vibe map layout after it/);
    });

    it("fails when the map is laid out between a vector run's first and last completion", () => {
        const log = lines("arm-first-install.log");
        const i = log.findIndex((l) => l.startsWith("2026-11-07T19:01:41.360"));
        log.splice(i, 0, "2026-11-07T18:59:00.000000000Z [INFO] [Enrichment] Vibe map laid out: 497 tracks");
        const breaks = check(log);
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(/vibe map was laid out at 2026-11-07T18:59:00.* in the middle of a sound vector run/);
    });

    it("passes a layout with no vectors (the gate's similarity + map journey) and layouts after every run", () => {
        const log = lines("arm-first-install.log");
        expect(log.filter((l) => l.includes("Vibe map laid out")).length).toBeGreaterThan(3);
        expect(check(log)).toEqual([]);
    });
});

describe("the stage records show each song's steps in order", () => {
    const log = parseDockerLog(fixture("arm-first-install.log"));
    const realRows = () => parseStageRows(fixture("arm-stage-rows.txt"));
    const withRows = (rows: StageRow[]) => findOrderBreaks({ lines: log, stageRows: rows });
    const row = (rows: StageRow[], trackId: string, stage: string) => rows.find((r) => r.trackId === trackId && r.stage === stage)!;
    const TRACK = "cmw6qy6c4000712no17lb441j";
    const OTHER = "cmw6qy6cc000912nonhr0mf2n";

    it("reads the rows the way the database printed them", () => {
        const rows = realRows();
        expect(rows).toHaveLength(12);
        expect(row(rows, TRACK, "fingerprint")).toEqual({
            trackId: TRACK,
            stage: "fingerprint",
            status: "done",
            startedAt: 1794076746810,
            finishedAt: 1794076747055,
        });
        expect(row(rows, TRACK, "embedding").finishedAt).toBeNull();
    });

    it("passes the real rows: fingerprint, then identification; analysis, then its sound vector", () => {
        expect(withRows(realRows())).toEqual([]);
    });

    it("fails when a song's identification started before its fingerprint finished", () => {
        const rows = realRows();
        row(rows, TRACK, "recording").startedAt = row(rows, TRACK, "fingerprint").finishedAt! - 1;
        const breaks = withRows(rows);
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(new RegExp(`identification of ${TRACK} started .* before its fingerprint finished`));
    });

    it("fails when a song's sound vector started before its analysis finished", () => {
        const rows = realRows();
        row(rows, TRACK, "embedding").startedAt = row(rows, TRACK, "analysis").finishedAt! - 1;
        const breaks = withRows(rows);
        expect(breaks.some((b) => new RegExp(`sound vector of ${TRACK} started .* before its analysis finished`).test(b))).toBe(true);
    });

    it("fails when a song's sound vector started and its analysis never finished", () => {
        const rows = realRows();
        Object.assign(row(rows, TRACK, "analysis"), { status: "working", finishedAt: null });
        const breaks = withRows(rows);
        expect(breaks.some((b) => new RegExp(`sound vector of ${TRACK} started .* its analysis had not finished`).test(b))).toBe(true);
    });

    it("does not count a sound vector record closed because its analysis failed (stamped when it was closed)", () => {
        const rows = realRows();
        // Closed while the analysis was failed; the analysis was reopened and answered afterwards.
        const closedAt = row(rows, TRACK, "analysis").startedAt! - 1_000;
        Object.assign(row(rows, TRACK, "embedding"), { status: "failed", startedAt: closedAt, finishedAt: closedAt });
        expect(withRows(rows)).toEqual([]);
    });

    it("fails when one song's analysis was held while another song's sound vector was", () => {
        const rows = realRows();
        const vector = row(rows, TRACK, "embedding");
        vector.finishedAt = vector.startedAt! + 800;
        row(rows, OTHER, "analysis").finishedAt = vector.startedAt! + 80;
        // The other song's own vector also started before its analysis finished, which is a second break.
        const breaks = withRows(rows);
        expect(breaks.filter((b) => new RegExp(`analysis of ${OTHER} .* was held while a sound vector was`).test(b))).toHaveLength(1);
    });
});

describe("a log that lost its oldest lines is not a clean result", () => {
    const rows = parseStageRows(fixture("arm-stage-rows.txt"));
    const log = parseDockerLog(fixture("arm-first-install.log"));
    const first = Date.parse("2026-11-07T18:38:13.757Z");

    it("passes when the log starts within a minute of the container's creation", () => {
        expect(findOrderBreaks({ lines: log, stageRows: rows, containerCreatedAt: first - 59_000 })).toEqual([]);
    });

    it("fails when the log's first line is more than 60 seconds after the container was created", () => {
        const breaks = findOrderBreaks({ lines: log, stageRows: rows, containerCreatedAt: first - 61_000 });
        expect(breaks).toHaveLength(1);
        expect(breaks[0]).toMatch(/log starts 61 s after the container was created.*first enrichment run was not checked/);
    });

    it("does not check the start when the container's creation time is not given", () => {
        expect(findOrderBreaks({ lines: log, stageRows: rows })).toEqual([]);
    });
});

describe("an empty input is not a clean result", () => {
    it("fails on a log with no analysis or vector completions, and says how many lines it read", () => {
        const breaks = check(["2026-11-07T18:38:10.171828019Z hello", "2026-11-07T18:38:11.171828019Z world"]);
        expect(breaks).toEqual(["the log holds no analysis or sound vector completion in its 2 lines: no enrichment run was seen"]);
    });

    it("fails on a log with no lines at all", () => {
        expect(check([])).toEqual(["the log holds no analysis or sound vector completion in its 0 lines: no enrichment run was seen"]);
    });

    it("fails when no stage rows were read", () => {
        const breaks = findOrderBreaks({ lines: parseDockerLog(fixture("arm-first-install.log")), stageRows: [] });
        expect(breaks).toEqual(["no stage rows were read: the order of each song's steps was not checked"]);
    });
});

describe("what the flow spec reads from the same log", () => {
    const lines = parseDockerLog(fixture("amd-album-added.log"));

    it("lists each model's completions in time order, with what each finished", () => {
        const done = completions(lines);
        expect(done.map((d) => (d.model === "musicnn" ? "m" : "c")).join("")).toBe("mmmmccccmmmmcccc");
        expect(done[0]).toEqual({ at: Date.parse("2026-11-07T19:28:48.606Z"), model: "musicnn", what: "Artist A/Album 1/01.flac" });
        expect(done[4]).toEqual({ at: Date.parse("2026-11-07T19:32:07.741Z"), model: "clap", what: "cmw6qpwq300u91v8wvgvv2ero" });
    });

    it("lists the vibe map layouts", () => {
        expect(mapLayouts(lines).map((l) => l.at)).toEqual([Date.parse("2026-11-07T19:33:51.626Z")]);
    });
});
