/**
 * The stage-record module, through its interface only, on the suite database: every move leaves the record and the
 * Track status columns saying the same thing. `expectColumnsMatch` holds the mapping by hand (not from the module), so
 * a move that writes one side and not the other fails here.
 */

import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
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

/** Waits until some statement in this database is blocked on a lock, so a test acts only once the move under test waits. */
async function waitUntilBlocked(): Promise<void> {
    for (let i = 0; i < 200; i++) {
        const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE NOT l.granted AND a.datname = current_database()`,
        );
        if (row.n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("nothing ever blocked on a lock");
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

        expect(claim).toEqual({ kind: "claimed", attempt: 1, redelivered: 0, jobId: `track-${id}-analysis-1-r0`, before: null });
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

    it("hands a retryable failure back as it was: still failed, same attempt, same retry time", async () => {
        const id = await seedTrack("r3");
        const retryAt = new Date(Date.now() - 60_000);
        await put(id, "analysis", "failed", { attempt: 2, failures: 2, retryable: true, nextRetryAt: retryAt });
        await setColumns(id, "failed", "pending");
        const claim = await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });
        if (claim.kind !== "claimed") throw new Error("not claimed");
        expect(claim.attempt).toBe(3);

        await stageRecords.release(id, "analysis", claim);

        const row = await record(id, "analysis");
        expect(row).toMatchObject({ status: "failed", attempt: 2, retryable: true, failures: 2 });
        expect(row?.nextRetryAt?.getTime()).toBe(retryAt.getTime());
        await expectColumnsMatch(id);
        // It is owed again, and the next claim is the attempt this one would have been.
        expect(await stageRecords.claim(id, "analysis", { jobKey: "k" })).toMatchObject({ kind: "claimed", attempt: 3 });
    });

    it("hands back a lease re-offer as the expired claim it was, so it can be re-offered again", async () => {
        const id = await seedTrack("r4");
        const expired = new Date(Date.now() - 1000);
        await put(id, "analysis", "working", { attempt: 1, redelivered: 1, nextRetryAt: expired });
        await setColumns(id, "processing", "pending");
        const claim = await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });
        if (claim.kind !== "claimed") throw new Error("not claimed");
        expect(claim.redelivered).toBe(2);

        await stageRecords.release(id, "analysis", claim);

        const row = await record(id, "analysis");
        expect(row).toMatchObject({ status: "working", attempt: 1, redelivered: 1 });
        expect(row?.nextRetryAt?.getTime()).toBe(expired.getTime());
        await expectColumnsMatch(id);
    });

    it("leaves a record alone when a newer claim holds it", async () => {
        const id = await seedTrack("r2");
        await put(id, "analysis", "working", { attempt: 2, nextRetryAt: new Date(Date.now() + 60_000) });
        await setColumns(id, "processing", "pending");

        await stageRecords.release(id, "analysis", { attempt: 1, redelivered: 0, before: null });
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

    it("settles nothing on a working record when the report names no claim", async () => {
        const id = await seedTrack("a8");
        // The record is re-claimed (attempt 2): a report that names no claim cannot say whose attempt it answers.
        await stageRecords.claim(id, "embedding", { jobKey: `track-${id}-embedding` });

        await stageRecords.answer(id, "embedding", "clap", { outcome: "embedded" });

        expect((await record(id, "embedding"))?.status).toBe("working");
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

    it("settles nothing on a working record when the report names no claim, whatever the error", async () => {
        const id = await seedTrack("f10");
        await stageRecords.claim(id, "analysis", { jobKey: `track-${id}-analysis` });

        await stageRecords.fail(id, "analysis", "analyzer", new Error("upstream hiccup: transient"));
        await stageRecords.fail(id, "analysis", "analyzer", new Error("corrupted audio data [DAMAGED]"));
        await stageRecords.failOutcome(id, "analysis", "analyzer", { kind: "permanent", error: { code: "X", message: "no" } });

        expect((await record(id, "analysis"))?.status).toBe("working");
        await expectColumnsMatch(id);
    });

    it("still settles a record that is not working when the report names no claim", async () => {
        const id = await seedTrack("f11");
        await put(id, "analysis", "failed", { attempt: 1, failures: 1, retryable: true });
        await setColumns(id, "failed", "pending");

        await stageRecords.fail(id, "analysis", "analyzer", new Error("upstream hiccup: transient"));

        expect(await record(id, "analysis")).toMatchObject({ status: "failed", failures: 2 });
        await expectColumnsMatch(id);
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

describe("askAgain, as the writers around it use it", () => {
    it("keeps the evidence on the record when none is given", async () => {
        const id = await seedTrack("w1");
        await put(id, "analysis", "failed", { failures: 2, evidence: { error: "boom" } });
        await setColumns(id, "failed", "pending");

        await stageRecords.askAgain({ stages: ["analysis"], trackIds: [id] });

        expect(await record(id, "analysis")).toMatchObject({ status: "pending", failures: 0 });
        expect((await record(id, "analysis"))?.evidence).toEqual({ error: "boom" });
        await expectColumnsMatch(id);
    });

    it("skips a song whose file is flagged missing, and reopens a parked one when told to", async () => {
        const gone = await seedTrack("w2", { missing: true });
        await put(gone, "analysis", "failed", { retryable: false });
        const parked = await seedTrack("w3");
        await put(parked, "analysis", "blocked", { retryable: false, decided: true });
        for (const id of [gone, parked]) await setColumns(id, "permanently_failed", "pending");

        const n = await stageRecords.askAgain({
            stages: ["analysis"], trackIds: [gone, parked], statuses: ["failed", "blocked"], songFileThere: true, clearDecision: true,
        });

        expect(n).toBe(1);
        expect((await record(gone, "analysis"))?.status).toBe("failed");
        expect(await record(parked, "analysis")).toMatchObject({ status: "pending", decidedAt: null });
        for (const id of [gone, parked]) await expectColumnsMatch(id);
    });

    it("reopens embeddings only for songs whose analysis is answered and which have no sound vector, up to a limit", async () => {
        const ready: string[] = [];
        for (const n of ["w4", "w5", "w6"]) {
            const id = await seedTrack(n);
            await put(id, "analysis", "done");
            await put(id, "embedding", "done");
            await setColumns(id, "completed", "completed");
            ready.push(id);
        }
        const notAnalysed = await seedTrack("w7");
        await put(notAnalysed, "analysis", "failed");
        await put(notAnalysed, "embedding", "failed");
        await setColumns(notAnalysed, "failed", "failed");

        const n = await stageRecords.askAgain({
            stages: ["embedding"], trackIds: [...ready, notAnalysed], afterAnswerOf: "analysis", withoutSoundVector: true, limit: 2,
        });

        expect(n).toBe(2);
        const reopened = await prisma.trackStage.count({ where: { trackId: { in: ready }, stage: "embedding", status: "pending" } });
        expect(reopened).toBe(2);
        expect((await record(notAnalysed, "embedding"))?.status).toBe("failed");
        for (const id of [...ready, notAnalysed]) await expectColumnsMatch(id);
    });

    it("does not reopen the embedding of a song that already has a sound vector", async () => {
        const id = await seedTrack("w8");
        await put(id, "analysis", "done");
        await put(id, "embedding", "done");
        await setColumns(id, "completed", "completed");
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at) VALUES ($1, $2::vector, 'test', now())`,
            id,
            `[${Array.from({ length: 512 }, (_, i) => (i % 7) / 7).join(",")}]`,
        );
        try {
            const n = await stageRecords.askAgain({
                stages: ["embedding"], trackIds: [id], afterAnswerOf: "analysis", withoutSoundVector: true,
            });
            expect(n).toBe(0);
        } finally {
            await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id = $1`, id);
        }
    });

    it("joins a caller's transaction, so the whole reset commits or rolls back together", async () => {
        const id = await seedTrack("w9");
        await put(id, "analysis", "done");
        await setColumns(id, "completed", "pending");

        await expect(
            prisma.$transaction(async (tx) => {
                expect(await stageRecords.askAgain({ stages: ["analysis"], trackIds: [id] }, tx)).toBe(1);
                throw new Error("the rest of the reset failed");
            }),
        ).rejects.toThrow("the rest of the reset failed");

        expect((await record(id, "analysis"))?.status).toBe("done");
        await expectColumnsMatch(id);
    });
});

describe("closeForMissingFiles", () => {
    it("closes the open records of a song flagged missing, with record and column saying the same thing", async () => {
        const gone = await seedTrack("m1", { missing: true });
        await put(gone, "analysis", "pending");
        await put(gone, "embedding", "failed", { retryable: true, nextRetryAt: new Date(Date.now() - 1000) });
        await put(gone, "recording", "pending");
        await setColumns(gone, "pending", "failed");
        const here = await seedTrack("m2");
        await put(here, "analysis", "pending");
        const answered = await seedTrack("m3", { missing: true });
        await put(answered, "analysis", "done");
        await setColumns(answered, "completed", "pending");

        const closed = await stageRecords.closeForMissingFiles();

        expect(closed).toBe(3);
        for (const stage of ["analysis", "embedding", "recording"]) {
            expect(await record(gone, stage)).toMatchObject({ status: "failed", retryable: false, failureClass: "FILE_MISSING" });
        }
        expect((await record(here, "analysis"))?.status).toBe("pending");
        expect((await record(answered, "analysis"))?.status).toBe("done");
        // The column carries the record's own words, not a second wording.
        const message = (await record(gone, "analysis"))?.lastErrorMessage;
        expect(message).toMatch(/file missing from the library/);
        const track = await prisma.track.findUniqueOrThrow({ where: { id: gone } });
        expect(track.analysisError).toBe(message);
        expect(track.vibeAnalysisError).toBe(message);
        for (const id of [gone, here, answered]) await expectColumnsMatch(id);
        expect(await stageRecords.closeForMissingFiles()).toBe(0);
    });

    it("leaves a record with a live claim alone, even one claimed while the closing waited", async () => {
        const gone = await seedTrack("m5", { missing: true });
        await put(gone, "analysis", "working", { attempt: 1, nextRetryAt: new Date(Date.now() + 60_000) });
        await put(gone, "embedding", "pending");
        await setColumns(gone, "processing", "pending");

        // A worker claims the embedding record in a transaction that is still open when the closing starts.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const held = new Promise<void>((resolve) => { locked = resolve; });
        const claiming = prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `UPDATE "TrackStage" SET status = 'working', attempt = attempt + 1 WHERE "trackId" = $1 AND stage = 'embedding'`,
                gone,
            );
            locked();
            await gate;
        });
        await held;
        const closing = stageRecords.closeForMissingFiles();
        await waitUntilBlocked();
        release();
        await claiming;

        expect(await closing).toBe(0);
        expect(await record(gone, "analysis")).toMatchObject({ status: "working", attempt: 1 });
        expect(await record(gone, "embedding")).toMatchObject({ status: "working", failureClass: null });
    });

    it("closes only the songs it is given, leaving other flagged songs to the sweep", async () => {
        const first = await seedTrack("m6", { missing: true });
        const second = await seedTrack("m7", { missing: true });
        for (const id of [first, second]) {
            await put(id, "analysis", "pending");
            await setColumns(id, "pending", "pending");
        }

        expect(await stageRecords.closeForMissingFiles(undefined, [first])).toBe(1);

        expect((await record(first, "analysis"))?.status).toBe("failed");
        expect((await record(second, "analysis"))?.status).toBe("pending");
        await expectColumnsMatch(first);
        await expectColumnsMatch(second);
        expect(await stageRecords.closeForMissingFiles()).toBe(1);
    });

    it("joins a caller's transaction", async () => {
        const gone = await seedTrack("m4", { missing: true });
        await put(gone, "analysis", "pending");
        await setColumns(gone, "pending", "pending");

        await expect(
            prisma.$transaction(async (tx) => {
                expect(await stageRecords.closeForMissingFiles(tx)).toBe(1);
                throw new Error("rolled back");
            }),
        ).rejects.toThrow("rolled back");

        expect((await record(gone, "analysis"))?.status).toBe("pending");
        await expectColumnsMatch(gone);
    });
});

describe("flagMissingFiles and returnFiles", () => {
    const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "P2010", meta: { code: "40P01" } });
    afterEach(() => jest.restoreAllMocks());

    /**
     * Another move holds a song's records, as any move of this module does first, and writes its row while the move
     * under test waits for the records: the row must be free for it, so the two never wait on each other.
     */
    async function whileAnotherMoveHolds(trackId: string, move: () => Promise<unknown>): Promise<unknown> {
        // The move's one more run would hide a deadlock; it must not have needed it.
        const warned = jest.spyOn(logger, "warn");
        let moving!: Promise<unknown>;
        await prisma.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(`SELECT id FROM "TrackStage" WHERE "trackId" = $1 ORDER BY stage FOR UPDATE`, trackId);
            moving = move();
            moving.catch(() => undefined);
            await waitUntilBlocked();
            await tx.$executeRawUnsafe(`UPDATE "Track" SET "analysisStatus" = 'processing' WHERE id = $1`, trackId);
        }, { timeout: 20_000 });
        const result = await moving;
        expect(warned).not.toHaveBeenCalledWith(expect.stringMatching(/lost a transaction conflict/));
        return result;
    }

    it("flags songs once and closes their open questions with the columns saying the same", async () => {
        const first = await seedTrack("f1");
        const again = await seedTrack("f2", { missing: true });
        const here = await seedTrack("f3");
        for (const id of [first, again, here]) {
            await put(id, "analysis", "pending");
            await put(id, "fingerprint", "pending");
            await setColumns(id, "pending", "pending");
        }
        const stamp = (await prisma.track.findUniqueOrThrow({ where: { id: again } })).missingSince;

        const result = await stageRecords.flagMissingFiles([first, again]);

        // `again` was flagged by an earlier scan: it keeps that time, and is not counted as found gone now.
        expect(result).toEqual({ flagged: 1, closed: 4 });
        expect((await prisma.track.findUniqueOrThrow({ where: { id: first } })).missingSince).not.toBeNull();
        expect((await prisma.track.findUniqueOrThrow({ where: { id: again } })).missingSince).toEqual(stamp);
        expect((await prisma.track.findUniqueOrThrow({ where: { id: here } })).missingSince).toBeNull();
        for (const id of [first, again]) {
            expect(await record(id, "analysis")).toMatchObject({ status: "failed", failureClass: "FILE_MISSING" });
            expect(await record(id, "fingerprint")).toMatchObject({ status: "failed", failureClass: "FILE_MISSING" });
        }
        expect((await record(here, "analysis"))?.status).toBe("pending");
        for (const id of [first, again, here]) await expectColumnsMatch(id);
    });

    it("with no songs named still closes the questions of songs flagged earlier", async () => {
        const gone = await seedTrack("f4", { missing: true });
        await put(gone, "analysis", "pending");
        await setColumns(gone, "pending", "pending");

        expect(await stageRecords.flagMissingFiles([])).toEqual({ flagged: 0, closed: 1 });
        expect((await record(gone, "analysis"))?.failureClass).toBe("FILE_MISSING");
        await expectColumnsMatch(gone);
    });

    it("returnFiles clears the flag and reopens only the questions the closure closed", async () => {
        const back = await seedTrack("r1");
        await put(back, "analysis", "pending");
        await put(back, "embedding", "failed", { retryable: false, failureClass: "DAMAGED" });
        await put(back, "recording", "done");
        await setColumns(back, "pending", "permanently_failed");
        await stageRecords.flagMissingFiles([back]);
        const other = await seedTrack("r2", { missing: true });
        await put(other, "analysis", "failed", { retryable: false, failureClass: "FILE_MISSING" });
        await setColumns(other, "permanently_failed", "pending");

        const reopened = await stageRecords.returnFiles([back]);

        expect(reopened).toBe(1);
        expect((await prisma.track.findUniqueOrThrow({ where: { id: back } })).missingSince).toBeNull();
        expect(await record(back, "analysis")).toMatchObject({ status: "pending", failures: 0 });
        expect(await record(back, "embedding")).toMatchObject({ status: "failed", failureClass: "DAMAGED" });
        expect((await record(back, "recording"))?.status).toBe("done");
        // A song not named stays flagged and closed.
        expect((await prisma.track.findUniqueOrThrow({ where: { id: other } })).missingSince).not.toBeNull();
        expect((await record(other, "analysis"))?.status).toBe("failed");
        for (const id of [back, other]) await expectColumnsMatch(id);
        expect(await stageRecords.returnFiles([])).toBe(0);
    });

    it("flagMissingFiles takes a song's records before its row, so a move holding the records and then writing the row is not caught in a deadlock", async () => {
        const id = await seedTrack("f5");
        await put(id, "analysis", "pending");
        await put(id, "fingerprint", "pending");

        const result = await whileAnotherMoveHolds(id, () => stageRecords.flagMissingFiles([id]));

        expect(result).toEqual({ flagged: 1, closed: 2 });
        expect((await prisma.track.findUniqueOrThrow({ where: { id } })).missingSince).not.toBeNull();
        await expectColumnsMatch(id);
    });

    it("flagMissingFiles also holds the records of songs flagged earlier before it writes any row", async () => {
        const earlier = await seedTrack("f6", { missing: true });
        await put(earlier, "analysis", "pending");
        await put(earlier, "fingerprint", "pending");
        const now = await seedTrack("f7");
        await put(now, "analysis", "pending");

        const result = await whileAnotherMoveHolds(earlier, () => stageRecords.flagMissingFiles([now]));

        expect(result).toEqual({ flagged: 1, closed: 3 });
        await expectColumnsMatch(earlier);
        await expectColumnsMatch(now);
    });

    it("returnFiles takes a song's records before its row too", async () => {
        const id = await seedTrack("r3", { missing: true });
        await put(id, "analysis", "failed", { retryable: false, failureClass: "FILE_MISSING" });
        await put(id, "fingerprint", "failed", { retryable: false, failureClass: "FILE_MISSING" });
        await setColumns(id, "permanently_failed", "pending");

        const reopened = await whileAnotherMoveHolds(id, () => stageRecords.returnFiles([id]));

        expect(reopened).toBe(2);
        expect((await prisma.track.findUniqueOrThrow({ where: { id } })).missingSince).toBeNull();
        await expectColumnsMatch(id);
    });

    /** The records of the suite's `h` songs that another transaction could take right now, as `trackId:stage`. */
    const takeable = async () =>
        (await prisma.$queryRawUnsafe<Array<{ trackId: string; stage: string }>>(
            `SELECT "trackId", stage FROM "TrackStage" WHERE "trackId" LIKE $1 ORDER BY "trackId", stage FOR UPDATE SKIP LOCKED`,
            `${PREFIX}_h%`,
        )).map((r) => `${r.trackId.slice(PREFIX.length + 1)}:${r.stage}`);

    async function seedHoldSongs(): Promise<void> {
        const gone = await seedTrack("h1", { missing: true });
        await put(gone, "analysis", "pending");
        await put(gone, "fingerprint", "pending", { decided: true });
        const here = await seedTrack("h2");
        await put(here, "analysis", "pending");
        await put(here, "fingerprint", "pending");
        await put(here, "embedding", "pending", { decided: true });
    }

    it("holdRecords holds, for the transaction, only the records the scope names", async () => {
        await seedHoldSongs();

        await prisma.$transaction(async (tx) => {
            await stageRecords.holdRecords(tx, { flagged: true });
            expect(await takeable()).toEqual(["h2:analysis", "h2:embedding", "h2:fingerprint"]);
        });
        await prisma.$transaction(async (tx) => {
            await stageRecords.holdRecords(tx, { trackIds: [tid("h2")] });
            expect(await takeable()).toEqual(["h1:analysis", "h1:fingerprint"]);
        });
        await prisma.$transaction(async (tx) => {
            // A re-run's records: the stage's, no person's decision among them, and every record of a flagged song.
            await stageRecords.holdRecords(tx, { undecidedStages: ["analysis"], flagged: true });
            expect(await takeable()).toEqual(["h2:embedding", "h2:fingerprint"]);
        });
        await prisma.$transaction(async (tx) => {
            await stageRecords.holdRecords(tx, {});
            expect(await takeable()).toHaveLength(5);
        });
    });

    it.each([
        ["flagMissingFiles", async (id: string) => stageRecords.flagMissingFiles([id]), { flagged: 1, closed: 1 }],
        ["returnFiles", async (id: string) => stageRecords.returnFiles([id]), 1],
    ] as const)("%s tries once more when it loses a deadlock, and gives up after that", async (name, run, expected) => {
        const id = await seedTrack(`d${name.length}`, { missing: name === "returnFiles" });
        await put(id, "analysis", name === "returnFiles" ? "failed" : "pending", name === "returnFiles"
            ? { retryable: false, failureClass: "FILE_MISSING" }
            : {});
        const spy = jest.spyOn(prisma, "$transaction").mockRejectedValueOnce(deadlock() as never);
        expect(await run(id)).toEqual(expected);
        expect(spy).toHaveBeenCalledTimes(2);

        spy.mockReset();
        spy.mockRejectedValueOnce(deadlock() as never).mockRejectedValueOnce(deadlock() as never);
        await expect(run(id)).rejects.toThrow("deadlock detected");
        expect(spy).toHaveBeenCalledTimes(2);
    });
});

describe("settleLandedAnswers", () => {
    /** A working record claimed five minutes ago, as the scheduler's claim would leave it. */
    async function working(trackId: string, stage: "analysis" | "embedding"): Promise<void> {
        await put(trackId, stage, "working", { attempt: 1, nextRetryAt: new Date(Date.now() + 10 * 60_000) });
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" SET "startedAt" = now() - interval '5 minutes' WHERE "trackId" = $1 AND stage = $2`,
            trackId,
            stage,
        );
        await setColumns(trackId, stage === "analysis" ? "processing" : "pending", stage === "embedding" ? "processing" : "pending");
    }

    it("answers a working analysis whose analyzer saved after the claim, columns and blended mood included", async () => {
        const id = await seedTrack("s1");
        await working(id, "analysis");
        await prisma.track.update({
            where: { id },
            data: { analyzedAt: new Date(Date.now() - 60_000), deamValence: 0.4, deamArousal: 0.4 },
        });

        expect(await stageRecords.settleLandedAnswers("analysis")).toBe(1);

        expect(await record(id, "analysis")).toMatchObject({ status: "done", source: "analyzer", nextRetryAt: null });
        const track = await prisma.track.findUniqueOrThrow({ where: { id } });
        expect(track.valence).toBeCloseTo(0.4, 3);
        await expectColumnsMatch(id);
    });

    it("answers a working embedding whose vector was saved after the claim, and leaves an older vector alone", async () => {
        const fresh = await seedTrack("s2");
        const older = await seedTrack("s3");
        await working(fresh, "embedding");
        await working(older, "embedding");
        const vector = `[${new Array(512).fill(0.1).join(",")}]`;
        for (const [id, age] of [[fresh, "1 minute"], [older, "1 hour"]] as const) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
                 VALUES ($1, $2::vector, 'test', now() - $3::interval)`,
                id, vector, age,
            );
        }

        expect(await stageRecords.settleLandedAnswers("embedding")).toBe(1);

        expect(await record(fresh, "embedding")).toMatchObject({ status: "done", source: "clap" });
        expect((await record(older, "embedding"))?.status).toBe("working");
        await expectColumnsMatch(fresh);
        await expectColumnsMatch(older);
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE $1`, `${PREFIX}_%`);
    });

    it("leaves a working record with no answer yet, and a record that is not working", async () => {
        const waiting = await seedTrack("s4");
        await working(waiting, "analysis");
        await prisma.track.update({ where: { id: waiting }, data: { analyzedAt: new Date(Date.now() - 3600_000) } });
        const failed = await seedTrack("s5");
        await put(failed, "analysis", "failed", { attempt: 1, failures: 1 });
        await prisma.track.update({ where: { id: failed }, data: { analyzedAt: new Date() } });

        expect(await stageRecords.settleLandedAnswers("analysis")).toBe(0);
        expect((await record(waiting, "analysis"))?.status).toBe("working");
        expect((await record(failed, "analysis"))?.status).toBe("failed");
    });

    it("asks again the embedding that was closed only because this analysis had failed", async () => {
        const id = await seedTrack("s6");
        await working(id, "analysis");
        await put(id, "embedding", "failed", { retryable: false, failureClass: "DEPENDENCY_CLOSED" });
        await setColumns(id, "processing", "permanently_failed");
        await prisma.track.update({ where: { id }, data: { analyzedAt: new Date(Date.now() - 60_000) } });

        await stageRecords.settleLandedAnswers("analysis");

        expect(await record(id, "embedding")).toMatchObject({ status: "pending", retryable: true });
        await expectColumnsMatch(id);
    });

    it("has nothing to settle for the stages that report in this process", async () => {
        expect(await stageRecords.settleLandedAnswers("recording")).toBe(0);
        expect(await stageRecords.settleLandedAnswers("fingerprint")).toBe(0);
    });

    it("leaves a record that was claimed again between the read and the settle working", async () => {
        const id = await seedTrack("s7");
        await working(id, "analysis");
        await prisma.track.update({ where: { id }, data: { analyzedAt: new Date(Date.now() - 60_000) } });

        // The scheduler re-claims the record in a transaction still open when the settle starts.
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => { finish = resolve; });
        let locked!: () => void;
        const held = new Promise<void>((resolve) => { locked = resolve; });
        const reclaiming = prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `UPDATE "TrackStage" SET attempt = attempt + 1, "startedAt" = now() WHERE "trackId" = $1 AND stage = 'analysis'`,
                id,
            );
            locked();
            await gate;
        });
        await held;
        const settling = stageRecords.settleLandedAnswers("analysis");
        await waitUntilBlocked();
        finish();
        await reclaiming;

        expect(await settling).toBe(0);
        expect(await record(id, "analysis")).toMatchObject({ status: "working", attempt: 2 });
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

describe("a move that loses a deadlock", () => {
    const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "P2010", meta: { code: "40P01" } });
    afterEach(() => jest.restoreAllMocks());

    /** The four set-based moves, each with a song they have work on. */
    const moves: Array<{
        name: string;
        seed: () => Promise<string>;
        run: () => Promise<number>;
        settled: (id: string) => Promise<void>;
    }> = [
        {
            name: "settleLandedAnswers",
            seed: async () => {
                const id = await seedTrack("dl1");
                await put(id, "analysis", "working", { attempt: 1, nextRetryAt: new Date(Date.now() + 600_000) });
                await prisma.$executeRawUnsafe(
                    `UPDATE "TrackStage" SET "startedAt" = now() - interval '5 minutes' WHERE "trackId" = $1`, id,
                );
                await prisma.track.update({ where: { id }, data: { analyzedAt: new Date(), analysisStatus: "processing" } });
                return id;
            },
            run: () => stageRecords.settleLandedAnswers("analysis"),
            settled: async (id) => expect((await record(id, "analysis"))?.status).toBe("done"),
        },
        {
            name: "closeDependents",
            seed: async () => {
                const id = await seedTrack("dl2");
                await put(id, "analysis", "failed", { retryable: false, failureClass: "DAMAGED" });
                await put(id, "embedding", "pending");
                await setColumns(id, "permanently_failed", "pending");
                return id;
            },
            run: () => stageRecords.closeDependents(),
            settled: async (id) => expect((await record(id, "embedding"))?.failureClass).toBe("DEPENDENCY_CLOSED"),
        },
        {
            name: "askAgain",
            seed: async () => {
                const id = await seedTrack("dl3");
                await put(id, "analysis", "failed", { attempt: 3, failures: 3, retryable: false });
                await setColumns(id, "permanently_failed", "pending");
                return id;
            },
            run: () => stageRecords.askAgain({ stages: ["analysis"], trackIds: [`${PREFIX}_dl3`], evidence: { reason: "test" } }),
            settled: async (id) => expect((await record(id, "analysis"))?.status).toBe("pending"),
        },
        {
            name: "closeForMissingFiles",
            seed: async () => {
                const id = await seedTrack("dl4", { missing: true });
                await put(id, "analysis", "pending");
                return id;
            },
            run: () => stageRecords.closeForMissingFiles(),
            settled: async (id) => expect((await record(id, "analysis"))?.failureClass).toBe("FILE_MISSING"),
        },
    ];

    it.each(moves)("$name tries once more and lands", async ({ seed, run, settled }) => {
        const id = await seed();
        const spy = jest.spyOn(prisma, "$transaction").mockRejectedValueOnce(deadlock() as never);

        expect(await run()).toBeGreaterThanOrEqual(1);

        expect(spy).toHaveBeenCalledTimes(2);
        await settled(id);
        await expectColumnsMatch(id);
    });

    it.each(moves)("$name gives up after that one retry, and does not retry any other failure", async ({ seed, run }) => {
        await seed();
        const spy = jest.spyOn(prisma, "$transaction")
            .mockRejectedValueOnce(deadlock() as never)
            .mockRejectedValueOnce(deadlock() as never);
        await expect(run()).rejects.toThrow("deadlock detected");
        expect(spy).toHaveBeenCalledTimes(2);

        spy.mockReset();
        spy.mockRejectedValueOnce(new Error("connection reset") as never);
        await expect(run()).rejects.toThrow("connection reset");
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("leaves the retry to the caller when the move joins the caller's transaction", async () => {
        const id = await seedTrack("dl5", { missing: true });
        await put(id, "analysis", "pending");
        const spy = jest.spyOn(prisma, "$transaction");
        await prisma.$transaction(async (tx) => {
            await stageRecords.closeForMissingFiles(tx, [id]);
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
