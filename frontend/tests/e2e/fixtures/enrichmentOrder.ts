/**
 * Finds where a stack's enrichment ran out of order, from its container log (every line stamped by `docker logs -t`)
 * and its TrackStage rows. Each break is one sentence.
 *
 * - One-at-a-time (log): MusiCNN finishing a song while a CLAP vector is between "Processing" and "Completed".
 *   (rows): a song's analysis held from first hand-out to answer while any vector is held. Cannot see work that was
 *   handed out and sat idle in a queue, only completions and recorded hand-out times; rows only keep the latest run.
 *   A vector is in flight from "Processing vibe" until its "Completed vibe", "Not stored" (claim re-issued), "Track X
 *   failed" or the worker's "Job ... failed" line; an analyzer restart ends every job. A new "Processing" line ends
 *   nothing, because CLAP may run several jobs at once. Lines name the track, not the job, so when a lease re-offer
 *   runs one track twice, the first copy's end also ends the second. "Job ? failed" (no job) ends nothing, so it can
 *   only report a break that was not there, never hide one.
 * - Once per run (log): an analysis run is the completions of MusiCNN with no CLAP completion between them; a vector
 *   run is the completions of CLAP with no MusiCNN completion and no "tracks owed vibe embedding" line (a forced or
 *   plain re-queue of the vectors) between them. A later run set off by a re-run may redo songs; a repeat inside one
 *   run is a break. Two back-to-back analysis re-runs with no vector between them look like one run, so they would be
 *   reported (stricter, not looser).
 * - Moods and map last (log): the latest "Vibe map laid out" must come after the last vector completion, and no layout
 *   may fall between a vector run's first and last completion. Layouts with no vectors (a map-only re-run) are fine.
 *   Work added while vectors run waits its turn and the map is laid out once after all of it, so one layout may cover
 *   several runs. The log cannot show whether an earlier stretch of work ended without its map when a later layout
 *   covers it: no line marks when a re-run was asked for or when enrichment went idle, so there is nothing to split on.
 *   "Mood tags changed" is logged only when tags changed, so moods are not checked on their own.
 * - Steps in order (rows): identification started no earlier than its fingerprint finished; a vector started no earlier
 *   than its analysis finished (records closed as failed are skipped: they are stamped when closed).
 * - Not checked: that the library scan finished first. Nothing logs it at INFO level and the job queue keeps only the
 *   latest scan job, so there is no evidence to read.
 * - Also not checked: sound vectors starting while analysis was owed but not yet handed out (the rows keep only
 *   hand-out and answer times; nothing marks when work became owed), and a map laid out while analysis was owed.
 * - Empty input is a break, never a clean result. So is a log whose first line is more than LOG_START_TOLERANCE_MS
 *   after the container was created (rotation dropped its oldest lines); the check runs only when the creation time is
 *   given.
 */
export interface LogLine {
    at: number;
    text: string;
}

/** One song's record for one step ("fingerprint", "recording", "analysis", "embedding"); times in epoch ms. */
export interface StageRow {
    trackId: string;
    stage: string;
    status: string;
    /** When the step was first handed out; null until then. */
    startedAt: number | null;
    /** When the step was answered or closed; null while it is open. */
    finishedAt: number | null;
}

/** How long after the container was created its log may begin. The first line normally comes within a second; 60 s leaves room for a slow start. */
export const LOG_START_TOLERANCE_MS = 60_000;

export interface OrderInput {
    lines: LogLine[];
    stageRows: StageRow[];
    /** When the container was created, epoch ms. When given, a log that begins later than the tolerance is a break. */
    containerCreatedAt?: number;
}

/** The query whose `psql -At` output `parseStageRows` reads. Times are epoch ms, so no time zone is involved. */
export const STAGE_ROWS_SQL = `SELECT "trackId", stage, status, extract(epoch from "startedAt") * 1000, extract(epoch from "finishedAt") * 1000 FROM "TrackStage"`;

const asTime = (field: string) => (field === "" ? null : Number(field));

/** `psql -At` output of `STAGE_ROWS_SQL`: one `trackId|stage|status|startedMs|finishedMs` line per row. */
export function parseStageRows(output: string): StageRow[] {
    return output
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
            const [trackId, stage, status, startedAt, finishedAt] = line.split("|");
            return { trackId, stage, status, startedAt: asTime(startedAt), finishedAt: asTime(finishedAt) };
        });
}

const MUSICNN_DONE = /audio-analyzer - INFO - ✓ Completed: (.+)$/;
const CLAP_DONE = /clap-analyzer - INFO - \[BullMQ\] Completed vibe for track: (\S+)/;
const CLAP_START = /clap-analyzer - INFO - \[BullMQ\] Processing vibe for track: (\S+)/;
// The other ways a started vector job ends (services/audio-analyzer-clap/analyzer.py): its claim re-issued while it
// ran, the analyzer's own failure report, the worker's failed-job line (the job id is `track-<id>-embedding-<n>-r<n>`),
// and a worker restart, which ends every job.
const CLAP_NOT_STORED = /clap-analyzer - INFO - \[BullMQ\] Not stored for (\S+): claim /;
const CLAP_FAILED = /clap-analyzer - ERROR - Track (\S+) failed: /;
const CLAP_JOB_FAILED = /clap-analyzer - ERROR - \[BullMQ\] Job track-(\S+)-embedding-\d+-r\d+ failed: /;
const CLAP_RESTART = /clap-analyzer - INFO - (?:BullMQVibeWorker starting\.\.\.|\[BullMQ\] Worker started with concurrency \d+)/;
const MAP_LAID_OUT = /Vibe map laid out: \d+ tracks/;
const VECTORS_OWED = /\d+ tracks owed vibe embedding/;

/** `docker logs -t` output (both streams): each line with Docker's own timestamp, in time order. */
export function parseDockerLog(raw: string): LogLine[] {
    return raw
        .split("\n")
        .map((line, index) => {
            const space = line.indexOf(" ");
            return { at: Date.parse(line.slice(0, space)), text: line.slice(space + 1), index };
        })
        .filter((l) => Number.isFinite(l.at))
        .sort((a, b) => a.at - b.at || a.index - b.index)
        .map(({ at, text }) => ({ at, text }));
}

/** Each analyzer's completions in log order, with what it finished (a file path for MusiCNN, a track id for CLAP). */
export function completions(lines: LogLine[]) {
    const out: Array<{ at: number; model: "musicnn" | "clap"; what: string }> = [];
    for (const l of lines) {
        const m = MUSICNN_DONE.exec(l.text);
        if (m) out.push({ at: l.at, model: "musicnn", what: m[1] });
        const c = CLAP_DONE.exec(l.text);
        if (c) out.push({ at: l.at, model: "clap", what: c[1] });
    }
    return out;
}

/** The log lines that say the vibe map was laid out. */
export function mapLayouts(lines: LogLine[]): LogLine[] {
    return lines.filter((l) => MAP_LAID_OUT.test(l.text));
}

export function findOrderBreaks({ lines, stageRows, containerCreatedAt }: OrderInput): string[] {
    const breaks: string[] = [];
    let analysed = new Map<string, number>();
    let vectored = new Map<string, number>();
    const closeAnalysis = () => {
        for (const [song, n] of analysed) if (n > 1) breaks.push(`analysed ${n} times in one run: ${song}`);
        analysed = new Map();
    };
    const closeVectors = () => {
        for (const [track, n] of vectored) if (n > 1) breaks.push(`got a sound vector ${n} times in one run: ${track}`);
        vectored = new Map();
    };
    let completionCount = 0;
    const vectorsInFlight = new Set<string>();
    const when = (l: LogLine) => new Date(l.at).toISOString();
    // The latest vector while no layout has followed it, and whether a vector run is open.
    let unmapped: LogLine | null = null;
    let vectorRunOpen = false;
    let layoutInRun: LogLine | null = null;
    const closeVectorRun = () => {
        vectorRunOpen = false;
        closeVectors();
    };
    for (const l of lines) {
        if (MAP_LAID_OUT.test(l.text)) {
            unmapped = null;
            if (vectorRunOpen) layoutInRun = l;
        }
        const m = MUSICNN_DONE.exec(l.text);
        const c = CLAP_DONE.exec(l.text);
        const started = CLAP_START.exec(l.text);
        if (m || c) completionCount++;
        if (started) vectorsInFlight.add(started[1]);
        for (const re of [CLAP_NOT_STORED, CLAP_FAILED, CLAP_JOB_FAILED]) {
            const ended = re.exec(l.text);
            if (ended) vectorsInFlight.delete(ended[1]);
        }
        if (CLAP_RESTART.test(l.text)) vectorsInFlight.clear();
        if (m) {
            if (vectorsInFlight.size > 0) breaks.push(`MusiCNN finished ${m[1]} while ${vectorsInFlight.size} sound vector(s) were being made`);
            closeVectorRun();
            analysed.set(m[1], (analysed.get(m[1]) ?? 0) + 1);
        } else if (c) {
            vectorsInFlight.delete(c[1]);
            closeAnalysis();
            if (!vectorRunOpen) {
                vectorRunOpen = true;
            } else if (layoutInRun) {
                breaks.push(`the vibe map was laid out at ${when(layoutInRun)} in the middle of a sound vector run`);
            }
            layoutInRun = null;
            unmapped = l;
            vectored.set(c[1], (vectored.get(c[1]) ?? 0) + 1);
        } else if (VECTORS_OWED.test(l.text)) closeVectorRun();
    }
    closeAnalysis();
    closeVectors();
    if (unmapped) breaks.push(`the sound vector made at ${when(unmapped)} has no vibe map layout after it`);
    if (completionCount === 0) breaks.push(`the log holds no analysis or sound vector completion in its ${lines.length} lines: no enrichment run was seen`);
    if (containerCreatedAt !== undefined && lines.length > 0 && lines[0].at - containerCreatedAt > LOG_START_TOLERANCE_MS) {
        const gap = Math.round((lines[0].at - containerCreatedAt) / 1000);
        breaks.push(`the log starts ${gap} s after the container was created: its oldest lines are gone, so the first enrichment run was not checked`);
    }
    if (stageRows.length === 0) breaks.push("no stage rows were read: the order of each song's steps was not checked");
    breaks.push(...stageRowBreaks(stageRows));
    return breaks;
}

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "unanswered");

/** Each stage's rows by track. */
function byStage(rows: StageRow[], stage: string) {
    return new Map(rows.filter((r) => r.stage === stage).map((r) => [r.trackId, r]));
}

function stageRowBreaks(rows: StageRow[]): string[] {
    const breaks: string[] = [];
    const fingerprints = byStage(rows, "fingerprint");
    const analyses = byStage(rows, "analysis");
    for (const r of rows) {
        if (r.stage === "recording" && r.startedAt !== null) {
            const f = fingerprints.get(r.trackId);
            if (f?.finishedAt != null && r.startedAt < f.finishedAt) {
                breaks.push(`identification of ${r.trackId} started at ${iso(r.startedAt)}, before its fingerprint finished at ${iso(f.finishedAt)}`);
            }
        }
        // A record closed because its analysis failed is stamped when it was closed, not when work started on it.
        if (r.stage === "embedding" && r.startedAt !== null && r.status !== "failed") {
            const a = analyses.get(r.trackId);
            if (a && a.finishedAt === null) {
                breaks.push(`sound vector of ${r.trackId} started at ${iso(r.startedAt)} and its analysis had not finished`);
            } else if (a && r.startedAt < a.finishedAt!) {
                breaks.push(`sound vector of ${r.trackId} started at ${iso(r.startedAt)}, before its analysis finished at ${iso(a.finishedAt!)}`);
            }
        }
    }
    // Held = from first handed out to answered (open-ended while unanswered). Analysis and vectors must not overlap.
    const held = (stage: string) =>
        rows
            .filter((r) => r.stage === stage && r.startedAt !== null)
            .map((r) => ({ trackId: r.trackId, from: r.startedAt!, to: r.finishedAt ?? Infinity }))
            .sort((a, b) => a.from - b.from);
    const vectors = held("embedding");
    for (const a of held("analysis")) {
        const clash = vectors.find((v) => v.from < a.to && a.from < v.to);
        if (clash) {
            breaks.push(`analysis of ${a.trackId} (${iso(a.from)} to ${iso(a.to)}) was held while a sound vector was (${clash.trackId}, ${iso(clash.from)} to ${iso(clash.to)})`);
        }
    }
    return breaks;
}
