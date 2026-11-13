/**
 * The stage-record module, through its interface only, on the suite database: every move leaves the record and the
 * Track status columns saying the same thing. `expectColumnsMatch` holds the mapping by hand (not from the module), so
 * a move that writes one side and not the other fails here.
 */

import { prisma } from "../../../utils/db";
import { sourcePauseController } from "../../sourcePauseController";
import * as stageRecords from "../stageRecords";
import { claimOf } from "../stageRecords";
import { STAGE_RETRY_CAP } from "../../../workers/stageRetry";

const PREFIX = "stgrec";
const tid = (n: string) => `${PREFIX}_${n}`;

jest.setTimeout(30_000);

interface RecordRow {
    id: string;
    status: string;
    source: string | null;
    attempt: number;
    redelivered: number;
    failures: number;
    retryable: boolean;
    failureClass: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    nextRetryAt: Date | null;
    decidedAt: Date | null;
    decidedBy: string | null;
    evidence: Record<string, unknown> | null;
}

async function record(trackId: string, stage: string): Promise<RecordRow | undefined> {
    const rows = await prisma.$queryRawUnsafe<RecordRow[]>(
        `SELECT * FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`,
        trackId,
        stage,
    );
    return rows[0];
}

/** What a record says, as the column that mirrors it must say. */
function expectedColumn(row: RecordRow | undefined): string {
    if (!row) return "pending";
    if (row.status === "working") return "processing";
    if (row.status === "done") return "completed";
    if (row.status === "failed") return row.retryable ? "failed" : "permanently_failed";
    if (row.status === "blocked") return "permanently_failed";
    return "pending";
}

/** The status columns of a track say what its analysis and embedding records say. */
async function expectColumnsMatch(trackId: string): Promise<void> {
    const track = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect({ trackId, analysis: track.analysisStatus }).toEqual({
        trackId,
        analysis: expectedColumn(await record(trackId, "analysis")),
    });
    expect({ trackId, embedding: track.vibeAnalysisStatus }).toEqual({
        trackId,
        embedding: expectedColumn(await record(trackId, "embedding")),
    });
}

async function seedTrack(
    n: string,
    opts: { missing?: boolean; recordingMbid?: string } = {},
): Promise<string> {
    const id = tid(n);
    await prisma.track.create({
        data: {
            id,
            albumId: tid("alb"),
            title: `Track ${n}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${id}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            missingSince: opts.missing ? new Date() : null,
            recordingMbid: opts.recordingMbid ?? null,
        },
    });
    return id;
}

async function put(
    trackId: string,
    stage: string,
    status: string,
    opts: {
        attempt?: number;
        redelivered?: number;
        failures?: number;
        retryable?: boolean;
        nextRetryAt?: Date | null;
        failureClass?: string | null;
        decided?: boolean;
        evidence?: Record<string, unknown>;
    } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, redelivered, failures, retryable, "nextRetryAt",
             "failureClass", "lastErrorCode", "lastErrorMessage", evidence, "startedAt", "decidedAt", "decidedBy")
         VALUES ($1, $2, $3, $4, 'analyzer', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, now(), $14, $15)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status, attempt = EXCLUDED.attempt, redelivered = EXCLUDED.redelivered,
                failures = EXCLUDED.failures, retryable = EXCLUDED.retryable, "nextRetryAt" = EXCLUDED."nextRetryAt",
                "failureClass" = EXCLUDED."failureClass", "lastErrorCode" = EXCLUDED."lastErrorCode",
                "lastErrorMessage" = EXCLUDED."lastErrorMessage", evidence = EXCLUDED.evidence,
                "decidedAt" = EXCLUDED."decidedAt", "decidedBy" = EXCLUDED."decidedBy"`,
        `${trackId}__${stage}`, trackId, stage, status,
        opts.attempt ?? 0, opts.redelivered ?? 0, opts.failures ?? 0, opts.retryable ?? true, opts.nextRetryAt ?? null,
        opts.failureClass ?? (status === "failed" ? "INCONCLUSIVE" : null),
        status === "failed" ? "SEEDED" : null, status === "failed" ? "seeded" : null,
        JSON.stringify(opts.evidence ?? { seeded: true }),
        opts.decided ? new Date() : null, opts.decided ? "tester" : null,
    );
}

/** Sets a track's two status columns by hand, as a record seeded by hand would have them. */
async function setColumns(trackId: string, analysis: string, embedding: string): Promise<void> {
    await prisma.track.update({ where: { id: trackId }, data: { analysisStatus: analysis, vibeAnalysisStatus: embedding } });
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "SourceAttempt" WHERE source LIKE $1`, `${PREFIX}_%`);
}

beforeAll(async () => {
    await wipe();
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, tid("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, tid("art"));
    await prisma.artist.create({ data: { id: tid("art"), name: "Stage Artist", identityKey: tid("a") } });
    await prisma.album.create({
        data: { id: tid("alb"), rgMbid: tid("rg"), artistId: tid("art"), title: "Stage Album", primaryType: "Album" },
    });
});

afterEach(wipe);

afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, tid("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, tid("art"));
});

describe("claim", () => {
    it("claims a question nobody has asked, naming the attempt in the job id and marking the column", async () => {
        const id = await seedTrack("c1");
        const claim = await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });

        expect(claim).toEqual({ kind: "claimed", attempt: 1, redelivered: 0, jobId: `track-${id}-analysis-1-r0` });
        expect(claimOf((claim as { jobId: string }).jobId)).toEqual({ attempt: 1, redelivered: 0 });
        const row = await record(id, "analysis");
        expect(row?.status).toBe("working");
        expect(row?.source).toBe("analyzer");
        expect(row?.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.analysisStartedAt).not.toBeNull();
        await expectColumnsMatch(id);
    });

    it("marks the embedding column for an embedding claim", async () => {
        const id = await seedTrack("c2");
        await stageRecords.claim(id, "embedding", { jobKey: `track-${id}-embedding` });
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.vibeAnalysisStatus).toBe("processing");
        expect(track.vibeAnalysisStartedAt).not.toBeNull();
        await expectColumnsMatch(id);
    });

    it("claims a stage with no column (recording) without touching the columns", async () => {
        const id = await seedTrack("c3");
        const claim = await stageRecords.claim(id, "recording", { jobKey: `track-${id}-recording` });
        expect(claim.kind).toBe("claimed");
        expect((await record(id, "recording"))?.source).toBe("musicbrainz");
        await expectColumnsMatch(id);
    });

    it("does not claim a record whose lease is live", async () => {
        const id = await seedTrack("c4");
        await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });
        expect((await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` })).kind).toBe("not-owed");
        expect((await record(id, "analysis"))?.attempt).toBe(1);
        await expectColumnsMatch(id);
    });

    it("re-offers a claim whose lease ran out as a redelivery, not a new attempt", async () => {
        const id = await seedTrack("c5");
        await put(id, "analysis", "working", { attempt: 1, nextRetryAt: new Date(Date.now() - 1000) });
        await setColumns(id, "processing", "pending");

        const claim = await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });
        expect(claim).toMatchObject({ kind: "claimed", attempt: 1, redelivered: 1, jobId: `track-${id}-analysis-1-r1` });
        await expectColumnsMatch(id);
    });

    it("closes a record that kept losing its worker, with its error mirrored", async () => {
        const id = await seedTrack("c6");
        await put(id, "analysis", "working", { attempt: 1, redelivered: 3, nextRetryAt: new Date(Date.now() - 1000) });
        await setColumns(id, "processing", "pending");

        expect((await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` })).kind).toBe("closed");
        const row = await record(id, "analysis");
        expect(row).toMatchObject({ status: "failed", retryable: false, lastErrorCode: "LOST_WORKER" });
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.analysisError).toMatch(/lost its worker|losing its worker/i);
        await expectColumnsMatch(id);
    });

    it("takes a retryable failure into its next attempt and never an answered or closed record", async () => {
        const failed = await seedTrack("c7");
        await put(failed, "analysis", "failed", { attempt: 1, failures: 1, retryable: true });
        await setColumns(failed, "failed", "pending");
        expect(await stageRecords.claim(failed, "analysis", { jobKey: "k" })).toMatchObject({ kind: "claimed", attempt: 2 });
        await expectColumnsMatch(failed);

        const done = await seedTrack("c8");
        await put(done, "analysis", "done");
        await setColumns(done, "completed", "pending");
        expect((await stageRecords.claim(done, "analysis", { jobKey: "k" })).kind).toBe("not-owed");

        const closed = await seedTrack("c9");
        await put(closed, "analysis", "failed", { retryable: false, failureClass: "DAMAGED" });
        await setColumns(closed, "permanently_failed", "pending");
        expect((await stageRecords.claim(closed, "analysis", { jobKey: "k" })).kind).toBe("not-owed");
        await expectColumnsMatch(done);
        await expectColumnsMatch(closed);
    });
});

describe("release", () => {
    it("hands a claim back, so the record is owed again and the column says pending", async () => {
        const id = await seedTrack("r1");
        const claim = await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });
        if (claim.kind !== "claimed") throw new Error("not claimed");

        await stageRecords.release(id, "analysis", claim);
        expect(await record(id, "analysis")).toMatchObject({ status: "pending", nextRetryAt: null });
        await expectColumnsMatch(id);
    });

    it("leaves a record alone when a newer claim holds it", async () => {
        const id = await seedTrack("r2");
        await put(id, "analysis", "working", { attempt: 2, nextRetryAt: new Date(Date.now() + 60_000) });
        await setColumns(id, "processing", "pending");

        await stageRecords.release(id, "analysis", { attempt: 1, redelivered: 0 });
        expect((await record(id, "analysis"))?.status).toBe("working");
        await expectColumnsMatch(id);
    });
});

describe("answer", () => {
    it("settles the open claim: record done, column completed, error cleared", async () => {
        const id = await seedTrack("a1");
        const claim = await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });
        if (claim.kind !== "claimed") throw new Error("not claimed");
        await prisma.track.update({ where: { id }, data: { analysisError: "old" } });

        await stageRecords.answer(id, "analysis", "analyzer", { answer: "completed" }, claim.jobId);

        const row = await record(id, "analysis");
        expect(row).toMatchObject({ status: "done", source: "analyzer", retryable: true, nextRetryAt: null });
        expect(row?.evidence).toEqual({ answer: "completed" });
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.analysisError).toBeNull();
        expect(track.analysisStartedAt).toBeNull();
        await expectColumnsMatch(id);
    });

    it("drops an answer for a claim that was re-issued", async () => {
        const id = await seedTrack("a2");
        await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });

        await stageRecords.answer(id, "analysis", "analyzer", {}, `track-${id}-analysis-9-r0`);
        expect((await record(id, "analysis"))?.status).toBe("working");
        await expectColumnsMatch(id);
    });

    it("answers a question nobody claimed (no job id), creating the record", async () => {
        const id = await seedTrack("a3");
        await stageRecords.answer(id, "embedding", "clap", { outcome: "embedded" });
        expect(await record(id, "embedding")).toMatchObject({ status: "done", source: "clap", attempt: 1 });
        await expectColumnsMatch(id);
    });

    it("never overwrites a record a person parked", async () => {
        const id = await seedTrack("a4");
        await put(id, "analysis", "blocked", { retryable: false, decided: true });
        await setColumns(id, "permanently_failed", "pending");

        await stageRecords.answer(id, "analysis", "analyzer", {});
        expect((await record(id, "analysis"))?.status).toBe("blocked");
        await expectColumnsMatch(id);
    });

    it("blends the two analyzers' valence and arousal when an embedding lands", async () => {
        const id = await seedTrack("a5");
        await prisma.track.update({
            where: { id },
            data: { deamValence: 0.2, deamArousal: 0.4, clapValenceRaw: 0.8, clapArousalRaw: 0.6 },
        });
        await stageRecords.answer(id, "embedding", "clap", {});
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.valence).toBeCloseTo(0.7 * 0.2 + 0.3 * 0.8, 3);
        expect(track.arousal).toBeCloseTo(0.5, 3);
    });

    it("reopens an embedding closed only because analysis had failed for good, columns and all", async () => {
        const id = await seedTrack("a6");
        await put(id, "analysis", "failed", { retryable: false, failureClass: "DAMAGED" });
        await put(id, "embedding", "failed", { retryable: false, failureClass: "DEPENDENCY_CLOSED" });
        await setColumns(id, "permanently_failed", "permanently_failed");

        await stageRecords.answer(id, "analysis", "analyzer", {});

        expect(await record(id, "embedding")).toMatchObject({ status: "pending", retryable: true, failures: 0, failureClass: null });
        await expectColumnsMatch(id);
    });

    it("leaves an embedding that failed for its own reasons alone", async () => {
        const id = await seedTrack("a7");
        await put(id, "embedding", "failed", { retryable: false, failureClass: "DAMAGED" });
        await setColumns(id, "pending", "permanently_failed");
        await stageRecords.answer(id, "analysis", "analyzer", {});
        expect((await record(id, "embedding"))?.status).toBe("failed");
        await expectColumnsMatch(id);
    });
});

describe("absent", () => {
    it("records 'the sources have nothing' as a done answer", async () => {
        const id = await seedTrack("ab1");
        await stageRecords.absent(id, "recording", "musicbrainz");
        const row = await record(id, "recording");
        expect(row?.status).toBe("done");
        expect(row?.evidence).toEqual({ reason: "sources have nothing" });
        await expectColumnsMatch(id);
    });

    it("keeps the evidence of what was asked", async () => {
        const id = await seedTrack("ab2");
        await stageRecords.absent(id, "recording", "acoustid", { acoustid: "no match" });
        expect((await record(id, "recording"))?.evidence).toEqual({ acoustid: "no match" });
    });
});

describe("fail", () => {
    it("takes a transient failure onto the retry ladder, mirroring failed and the count", async () => {
        const id = await seedTrack("f1");
        const claim = await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });
        if (claim.kind !== "claimed") throw new Error("not claimed");

        await stageRecords.fail(id, "analysis", "analyzer", new Error("upstream hiccup: transient"), { reported: true }, claim.jobId);

        const row = await record(id, "analysis");
        expect(row).toMatchObject({ status: "failed", retryable: true, failures: 1, attempt: 1 });
        expect(row?.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.analysisRetryCount).toBe(1);
        expect(track.analysisError).toContain("upstream hiccup");
        await expectColumnsMatch(id);
    });

    it("closes the record when the ladder runs out", async () => {
        const id = await seedTrack("f2");
        await put(id, "embedding", "working", { attempt: 4, failures: STAGE_RETRY_CAP - 1, nextRetryAt: new Date(Date.now() + 60_000) });
        await setColumns(id, "pending", "processing");

        await stageRecords.fail(id, "embedding", "clap", new Error("upstream hiccup: transient"), {}, `track-${id}-embedding-4-r0`);

        expect(await record(id, "embedding")).toMatchObject({ status: "failed", retryable: false, failures: STAGE_RETRY_CAP });
        await expectColumnsMatch(id);
    });

    it("closes at once on a corruption signature", async () => {
        const id = await seedTrack("f3");
        await stageRecords.fail(id, "analysis", "analyzer", new Error("corrupted audio data [DAMAGED]"));
        expect(await record(id, "analysis")).toMatchObject({ status: "failed", retryable: false, failureClass: "DAMAGED" });
        await expectColumnsMatch(id);
    });

    it("drops a failure for a claim that was re-issued, and one that reaches an answered record", async () => {
        const stale = await seedTrack("f4");
        await stageRecords.claim(stale, "analysis", { jobKey: "k" });
        await stageRecords.fail(stale, "analysis", "analyzer", new Error("boom"), {}, "k-7-r0");
        expect((await record(stale, "analysis"))?.status).toBe("working");

        const done = await seedTrack("f5");
        await stageRecords.answer(done, "analysis", "analyzer", {});
        await stageRecords.fail(done, "analysis", "analyzer", new Error("boom"));
        expect((await record(done, "analysis"))?.status).toBe("done");
        await expectColumnsMatch(stale);
        await expectColumnsMatch(done);
    });

    it("parks a rate-limited question pending with no attempt used, and pauses only its source", async () => {
        const id = await seedTrack("f6");
        const claim = await stageRecords.claim(id, "embedding", { jobKey: `track-${id}-embedding`, source: `${PREFIX}_src` });
        if (claim.kind !== "claimed") throw new Error("not claimed");

        await stageRecords.fail(id, "embedding", `${PREFIX}_src`, new Error("429 rate limit exceeded"), {}, claim.jobId);

        const row = await record(id, "embedding");
        expect(row).toMatchObject({ status: "pending", lastErrorCode: "RATE_LIMITED", failures: 0 });
        expect(row?.nextRetryAt).not.toBeNull();
        expect(await sourcePauseController.isPaused(`${PREFIX}_src`)).toBe(true);
        await expectColumnsMatch(id);
    });

    it("closes a question for good when the source says it can never be answered", async () => {
        const id = await seedTrack("f7");
        await stageRecords.failOutcome(id, "analysis", "analyzer", {
            kind: "permanent",
            error: { code: "NOT_FOUND", message: "no such thing" },
        });
        expect(await record(id, "analysis")).toMatchObject({ status: "failed", retryable: false, failureClass: "PERMANENT", failures: 1 });
        await expectColumnsMatch(id);
    });

    it("sends a transient outcome down the retry ladder and parks a rate-limited one until it lifts", async () => {
        const a = await seedTrack("f8");
        await stageRecords.failOutcome(a, "analysis", "analyzer", {
            kind: "transient",
            error: { code: "TIMEOUT", message: "timed out" },
        });
        expect(await record(a, "analysis")).toMatchObject({ status: "failed", retryable: true, failures: 1 });
        await expectColumnsMatch(a);

        const b = await seedTrack("f9");
        const until = new Date(Date.now() + 120_000);
        await stageRecords.failOutcome(b, "embedding", "clap", { kind: "rateLimited", retryAfter: until, evidence: {} });
        expect(await record(b, "embedding")).toMatchObject({ status: "pending", lastErrorCode: "RATE_LIMITED" });
        await expectColumnsMatch(b);
    });
});

describe("closeDependents", () => {
    it("closes an embedding whose analysis closed for good, mirroring the column", async () => {
        const id = await seedTrack("d1");
        await put(id, "analysis", "failed", { retryable: false, failureClass: "DAMAGED" });
        await put(id, "embedding", "pending");
        await setColumns(id, "permanently_failed", "pending");

        const closed = await stageRecords.closeDependents();
        expect(closed).toBeGreaterThanOrEqual(1);
        expect(await record(id, "embedding")).toMatchObject({
            status: "failed",
            retryable: false,
            failureClass: "DEPENDENCY_CLOSED",
            source: "clap",
        });
        await expectColumnsMatch(id);
    });

    it("closes it for a parked analysis too, and does it only once", async () => {
        const id = await seedTrack("d2");
        await put(id, "analysis", "blocked", { retryable: false, decided: true });
        await put(id, "embedding", "pending");
        await setColumns(id, "permanently_failed", "pending");

        await stageRecords.closeDependents();
        expect((await record(id, "embedding"))?.failureClass).toBe("DEPENDENCY_CLOSED");
        expect(await prisma.$queryRawUnsafe(`SELECT 1 FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'embedding' AND status = 'pending'`, id)).toHaveLength(0);
        await expectColumnsMatch(id);
    });

    it("leaves an embedding alone while analysis may still answer, and one that is already answered", async () => {
        const waiting = await seedTrack("d3");
        await put(waiting, "analysis", "failed", { retryable: true });
        await put(waiting, "embedding", "pending");
        await setColumns(waiting, "failed", "pending");

        const answered = await seedTrack("d4");
        await put(answered, "analysis", "failed", { retryable: false });
        await put(answered, "embedding", "done");
        await setColumns(answered, "permanently_failed", "completed");

        await stageRecords.closeDependents();
        expect((await record(waiting, "embedding"))?.status).toBe("pending");
        expect((await record(answered, "embedding"))?.status).toBe("done");
        await expectColumnsMatch(waiting);
        await expectColumnsMatch(answered);
    });
});

describe("askAgain", () => {
    it("reopens one song's failed question with its budget back, and the columns follow", async () => {
        const id = await seedTrack("k1");
        await put(id, "analysis", "failed", { attempt: 3, failures: 3, retryable: false, failureClass: "DAMAGED" });
        await setColumns(id, "permanently_failed", "pending");
        await prisma.track.update({ where: { id }, data: { analysisError: "bad", analysisRetryCount: 3 } });

        const n = await stageRecords.askAgain({ stages: ["analysis"], trackIds: [id], evidence: { reason: "test" } });

        expect(n).toBe(1);
        expect(await record(id, "analysis")).toMatchObject({
            status: "pending", failures: 0, redelivered: 0, retryable: true, nextRetryAt: null, failureClass: null, lastErrorCode: null,
        });
        expect((await record(id, "analysis"))?.evidence).toEqual({ reason: "test" });
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.analysisError).toBeNull();
        expect(track.analysisRetryCount).toBe(0);
        await expectColumnsMatch(id);
    });

    it("keeps a person's decision unless told to clear it", async () => {
        const id = await seedTrack("k2");
        await put(id, "recording", "done", { decided: true });
        await stageRecords.askAgain({ stages: ["recording"], trackIds: [id], evidence: { reason: "x" } });
        expect((await record(id, "recording"))?.decidedAt).not.toBeNull();

        await stageRecords.askAgain({ stages: ["recording"], trackIds: [id], evidence: { reason: "x" }, clearDecision: true });
        expect(await record(id, "recording")).toMatchObject({ decidedAt: null, decidedBy: null });
    });

    it("narrows to the statuses, retryability and failure class asked for", async () => {
        const spent = await seedTrack("k3");
        await put(spent, "analysis", "failed", { retryable: false, failures: 4, failureClass: "DAMAGED" });
        const retryable = await seedTrack("k4");
        await put(retryable, "analysis", "failed", { retryable: true, failures: 2 });
        const done = await seedTrack("k5");
        await put(done, "analysis", "done");
        for (const id of [spent, retryable]) await setColumns(id, "failed", "pending");
        await setColumns(done, "completed", "pending");

        await stageRecords.askAgain({
            stages: ["analysis"], trackIds: [spent, retryable, done], statuses: ["failed"], retryable: true,
            evidence: { reason: "r" },
        });
        expect(await record(retryable, "analysis")).toMatchObject({ status: "pending", failures: 0 });
        expect((await record(spent, "analysis"))?.status).toBe("failed");
        expect((await record(done, "analysis"))?.status).toBe("done");

        await stageRecords.askAgain({
            stages: ["analysis"], trackIds: [spent, retryable, done], failureClass: "DAMAGED", evidence: { reason: "r" },
        });
        expect(await record(spent, "analysis")).toMatchObject({ status: "pending", failures: 0 });
        expect((await record(done, "analysis"))?.status).toBe("done");
        for (const id of [spent, retryable, done]) await expectColumnsMatch(id);
    });

    it("matches a record by one piece of its evidence", async () => {
        const hit = await seedTrack("k6");
        await put(hit, "recording", "done", { evidence: { acoustid: "not asked" } });
        const miss = await seedTrack("k7");
        await put(miss, "recording", "done", { evidence: { acoustid: "no match" } });

        const n = await stageRecords.askAgain({
            stages: ["recording"], trackIds: [hit, miss], statuses: ["done"],
            evidenceEquals: { acoustid: "not asked" }, evidence: { reason: "fingerprint landed" },
        });
        expect(n).toBe(1);
        expect((await record(hit, "recording"))?.status).toBe("pending");
        expect((await record(miss, "recording"))?.status).toBe("done");
    });

    it("reopens exactly the records named by id", async () => {
        const picked = await seedTrack("k12");
        await put(picked, "analysis", "failed", { retryable: false, failures: 4 });
        const other = await seedTrack("k13");
        await put(other, "analysis", "failed", { retryable: false, failures: 4 });
        for (const id of [picked, other]) await setColumns(id, "permanently_failed", "pending");

        const n = await stageRecords.askAgain({
            stages: ["analysis"], recordIds: [`${picked}__analysis`], evidence: { reason: "chosen" },
        });
        expect(n).toBe(1);
        expect(await record(picked, "analysis")).toMatchObject({ status: "pending", failures: 0 });
        expect((await record(other, "analysis"))?.status).toBe("failed");
        for (const id of [picked, other]) await expectColumnsMatch(id);
    });

    it("skips records a person decided when asked to, and recordings already identified", async () => {
        const decided = await seedTrack("k8");
        await put(decided, "analysis", "done", { decided: true });
        const open = await seedTrack("k9");
        await put(open, "analysis", "done");
        const identified = await seedTrack("k10", { recordingMbid: "mbid-1" });
        await put(identified, "recording", "done");
        const unidentified = await seedTrack("k11");
        await put(unidentified, "recording", "done");
        for (const id of [decided, open, identified, unidentified]) await setColumns(id, "completed", "pending");

        await stageRecords.askAgain({
            stages: ["analysis"], trackIds: [decided, open], undecidedOnly: true, evidence: { reason: "r" },
        });
        expect((await record(decided, "analysis"))?.status).toBe("done");
        expect((await record(open, "analysis"))?.status).toBe("pending");

        await stageRecords.askAgain({
            stages: ["recording"], trackIds: [identified, unidentified], keepIdentifiedRecordings: true, evidence: { reason: "r" },
        });
        expect((await record(identified, "recording"))?.status).toBe("done");
        expect((await record(unidentified, "recording"))?.status).toBe("pending");
        for (const id of [decided, open]) await expectColumnsMatch(id);
    });

    it("reopens only what a bulk re-ask may: not running, not parked, file present", async () => {
        const working = await seedTrack("k12");
        await put(working, "analysis", "working", { attempt: 1, nextRetryAt: new Date(Date.now() + 60_000) });
        await setColumns(working, "processing", "pending");
        const parked = await seedTrack("k13");
        await put(parked, "analysis", "blocked", { retryable: false, decided: true });
        await setColumns(parked, "permanently_failed", "pending");
        const gone = await seedTrack("k14", { missing: true });
        await put(gone, "analysis", "failed", { retryable: false, failureClass: "DAMAGED" });
        await setColumns(gone, "permanently_failed", "pending");
        const fine = await seedTrack("k15");
        await put(fine, "analysis", "failed");
        await setColumns(fine, "failed", "pending");

        await stageRecords.askAgain({
            stages: ["analysis"], trackIds: [working, parked, gone, fine], reopenableOnly: true, evidence: { reason: "r" },
        });
        expect((await record(working, "analysis"))?.status).toBe("working");
        expect((await record(parked, "analysis"))?.status).toBe("blocked");
        expect((await record(gone, "analysis"))?.status).toBe("failed");
        expect((await record(fine, "analysis"))?.status).toBe("pending");
        for (const id of [working, parked, gone, fine]) await expectColumnsMatch(id);
    });

    it("asks every stage of the library again when given no song list", async () => {
        const id = await seedTrack("k16");
        await put(id, "analysis", "done");
        await put(id, "embedding", "done");
        await setColumns(id, "completed", "completed");

        const n = await stageRecords.askAgain({ stages: ["analysis", "embedding"], evidence: { reason: "all" } });
        expect(n).toBeGreaterThanOrEqual(2);
        expect((await record(id, "analysis"))?.status).toBe("pending");
        expect((await record(id, "embedding"))?.status).toBe("pending");
        await expectColumnsMatch(id);
    });
});

describe("decide", () => {
    it("parks open and failed records as a person's decision, with the columns closed", async () => {
        const a = await seedTrack("p1");
        await put(a, "analysis", "failed");
        await setColumns(a, "failed", "pending");
        const b = await seedTrack("p2");
        await put(b, "embedding", "pending");
        const c = await seedTrack("p3");
        await put(c, "analysis", "done");
        await setColumns(c, "completed", "pending");

        const n = await stageRecords.decide(
            [`${a}__analysis`, `${b}__embedding`, `${c}__analysis`, "no-such-record"],
            "resolved-via-failures-api",
        );

        expect(n).toBe(2);
        expect(await record(a, "analysis")).toMatchObject({
            status: "blocked", retryable: false, nextRetryAt: null, decidedBy: "resolved-via-failures-api",
        });
        expect((await record(a, "analysis"))?.decidedAt).not.toBeNull();
        expect((await record(c, "analysis"))?.status).toBe("done");
        for (const id of [a, b, c]) await expectColumnsMatch(id);
    });

    it("is undone only by asking again with the decision cleared", async () => {
        const id = await seedTrack("p4");
        await put(id, "analysis", "failed");
        await setColumns(id, "failed", "pending");
        await stageRecords.decide([`${id}__analysis`], "tester");

        await stageRecords.askAgain({ stages: ["analysis"], trackIds: [id], clearDecision: true, evidence: { reason: "undo" } });
        expect(await record(id, "analysis")).toMatchObject({ status: "pending", decidedAt: null, decidedBy: null });
        await expectColumnsMatch(id);
    });
});
