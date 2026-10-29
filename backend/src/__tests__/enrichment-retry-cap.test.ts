/**
 * A temporary error leaves the stage record `failed` and retryable with a
 * growing wait; at the cap it stops being retryable and the dequeuer stops
 * offering it. An answered question (`done` or terminal) is never re-offered.
 */

import { prisma } from "../utils/db";
import {
    closeOrphanedDependents,
    getNextWork,
    recordStageAbsent,
    recordStageFailure,
    recordStageSuccess,
} from "../workers/unifiedEnrichment";
import { STAGE_RETRY_CAP, computeStageRetryWaitMs } from "../workers/stageRetry";
import { closeEngineConnections } from "./helpers/engineConnections";

const PREFIX = "retrycap";
const id = (n: string) => `${PREFIX}_${n}`;

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { attempt?: number; retryable?: boolean; nextRetryAt?: Date | null } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, "nextRetryAt", evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                attempt = EXCLUDED.attempt,
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence`,
        `${trackId}__${stage}`, trackId, stage, status, "musicbrainz",
        opts.attempt ?? 0, opts.retryable ?? true, opts.nextRetryAt ?? null,
        JSON.stringify({ probe: "mb-search", rc: 1 }),
    );
}

async function seedTrack(
    trackId: string,
    opts: { recording?: { status: string; attempt?: number; retryable?: boolean; nextRetryAt?: Date | null } } = {},
): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: "pending",
        },
    });
    await putStage(trackId, "recording", opts.recording?.status ?? "pending", {
        attempt: opts.recording?.attempt ?? 0,
        retryable: opts.recording?.retryable ?? true,
        nextRetryAt: opts.recording?.nextRetryAt ?? null,
    });
}

async function getRecord(trackId: string, stage: string): Promise<any> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`,
        trackId,
        stage,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

async function seedFkChain(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Retry Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Retry Album", primaryType: "Album" },
    });
}

beforeEach(async () => {
    await wipe();
    await seedFkChain();
    // Never let a pause left over from another case hide the work under test.
    await prisma.sourceAttempt.deleteMany({ where: { source: "musicbrainz" } });
});

afterAll(async () => {
    await wipe();
    await prisma.sourceAttempt.deleteMany({ where: { source: "musicbrainz" } });
    await prisma.$disconnect();
    await closeEngineConnections();
});

describe("increasing waits for temporary errors", () => {
    it("computeStageRetryWaitMs climbs 1 min, 10 min, 1 h", () => {
        expect(computeStageRetryWaitMs(1)).toBe(60_000);
        expect(computeStageRetryWaitMs(2)).toBe(600_000);
        expect(computeStageRetryWaitMs(3)).toBe(3_600_000);
    });

    it("first failure parks the record until now + wait(1), second until now + wait(2)", async () => {
        const trackId = id("temp");
        await seedTrack(trackId, { recording: { status: "working", attempt: 0 } });

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("connection reset by peer"));
        const first = await getRecord(trackId, "recording");
        expect(first.status).toBe("failed");
        expect(first.retryable).toBe(true);
        expect(first.attempt).toBe(1);
        expect(new Date(first.nextRetryAt).getTime()).toBeGreaterThan(Date.now() - 1000);

        // Second failure: the wait must be LONGER than the first, not the same.
        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("connection reset by peer"));
        const second = await getRecord(trackId, "recording");
        expect(second.attempt).toBe(2);
        expect(new Date(second.nextRetryAt).getTime()).toBeGreaterThan(
            new Date(first.nextRetryAt).getTime(),
        );
    });

    it("the record is not offered before its nextRetryAt and is offered after", async () => {
        const notDue = id("notdue");
        const due = id("due");
        await seedTrack(notDue, {
            recording: { status: "failed", attempt: 1, nextRetryAt: new Date(Date.now() + 10 * 60_000) },
        });
        await seedTrack(due, {
            recording: { status: "failed", attempt: 1, nextRetryAt: new Date(Date.now() - 60_000) },
        });
        // Both tracks' fingerprint questions are SETTLED, so the recording
        // rows are actually offered when due (the fingerprint → recording
        // gate holds them while the question is open).
        await putStage(due, "fingerprint", "done");
        await putStage(notDue, "fingerprint", "done");

        const offered = await getNextWork(10);
        const offeredIds = offered.filter((w) => w.stage === "recording").map((w) => w.trackId);
        expect(offeredIds).not.toContain(notDue);
        expect(offeredIds).toContain(due);
    });
});

describe("no retry past the cap", () => {
    it("the cap is 3 retries — 4 dispatches in all", () => {
        expect(STAGE_RETRY_CAP).toBe(4);
    });

    it("attempts 1 to 3 stay retryable; the fourth failure closes the record", async () => {
        const trackId = id("cap");
        await seedTrack(trackId, { recording: { status: "working", attempt: 0 } });

        for (let attempt = 1; attempt <= 3; attempt++) {
            await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));
            const rec = await getRecord(trackId, "recording");
            expect(rec.attempt).toBe(attempt);
            expect(rec.retryable).toBe(true);
        }

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));
        const closed = await getRecord(trackId, "recording");
        expect(closed.attempt).toBe(4);
        expect(closed.status).toBe("failed");
        expect(closed.retryable).toBe(false);

        // A closed record is never re-offered, and a later failure call
        // cannot resurrect it. (The track's other questions — e.g. its
        // never-asked fingerprint — are separate records and may still be
        // owed; the closed one is not.)
        const offered = await getNextWork(10);
        expect(
            offered.filter((w) => w.stage === "recording").map((w) => w.trackId),
        ).not.toContain(trackId);

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));
        expect((await getRecord(trackId, "recording")).retryable).toBe(false);
    });
});

describe("a question with an answer is never re-offered", () => {
    it("a done record is not offered even when the Track column still looks pending", async () => {
        const trackId = id("answered");
        await seedTrack(trackId, { recording: { status: "done", attempt: 1 } });

        const offered = await getNextWork(10);
        // The recording question is answered — it must not come back. (The
        // analysis record does not exist yet, so analysis is legitimately
        // due; the answered question here is the recording one.)
        expect(
            offered
                .filter((w) => w.stage === "recording")
                .map((w) => w.trackId),
        ).not.toContain(trackId);
    });

    it("recordStageSuccess writes done with its evidence and source", async () => {
        const trackId = id("success");
        await seedTrack(trackId, { recording: { status: "working", attempt: 0 } });

        await recordStageSuccess(trackId, "recording", "file_tag", {
            recordingMbid: "mb-123",
            reason: "tag carried the recording id",
        });

        const rec = await getRecord(trackId, "recording");
        expect(rec.status).toBe("done");
        expect(rec.source).toBe("file_tag");
        expect(rec.evidence).toMatchObject({ recordingMbid: "mb-123" });
        expect(rec.finishedAt).toBeTruthy();

        const offered = await getNextWork(10);
        expect(
            offered
                .filter((w) => w.stage === "recording")
                .map((w) => w.trackId),
        ).not.toContain(trackId);
    });
});

describe("a closed record always carries its start stamp", () => {
    it("a success close of a never-claimed record stamps startedAt with the close", async () => {
        const trackId = id("stamp-done");
        await seedTrack(trackId, { recording: { status: "pending" } });
        expect((await getRecord(trackId, "recording")).startedAt).toBeNull();

        await recordStageSuccess(trackId, "recording", "file_tag", { recordingMbid: "mb-1" });

        const rec = await getRecord(trackId, "recording");
        expect(rec.status).toBe("done");
        expect(rec.startedAt).toBeTruthy();
        expect(new Date(rec.startedAt).getTime()).toBeLessThanOrEqual(
            new Date(rec.finishedAt).getTime(),
        );
    });

    it("an absent close of a never-claimed record stamps startedAt", async () => {
        const trackId = id("stamp-absent");
        await seedTrack(trackId, { recording: { status: "pending" } });

        await recordStageAbsent(trackId, "recording", "musicbrainz", {
            reason: "sources have no recording for this track",
        });

        const rec = await getRecord(trackId, "recording");
        expect(rec.status).toBe("done");
        expect(rec.startedAt).toBeTruthy();
    });

    it("a failure close of a never-claimed record stamps startedAt", async () => {
        const trackId = id("stamp-fail");
        await seedTrack(trackId, { recording: { status: "pending" } });

        await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"));

        const rec = await getRecord(trackId, "recording");
        expect(rec.status).toBe("failed");
        expect(rec.startedAt).toBeTruthy();
    });

    it("a re-answer keeps the original claim stamp", async () => {
        const trackId = id("stamp-keep");
        await seedTrack(trackId, { recording: { status: "working", attempt: 1 } });
        const claimTime = new Date(Date.now() - 3_600_000);
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" SET "startedAt" = $2 WHERE "trackId" = $1 AND stage = 'recording'`,
            trackId,
            claimTime,
        );

        await recordStageSuccess(trackId, "recording", "acoustid", { recordingMbid: "mb-2" });

        const rec = await getRecord(trackId, "recording");
        expect(new Date(rec.startedAt).getTime()).toBe(claimTime.getTime());
    });

    it("a dependency-closed record carries both stamps", async () => {
        const trackId = id("stamp-dep");
        await seedTrack(trackId, { recording: { status: "done", attempt: 1 } });
        await putStage(trackId, "analysis", "failed", { attempt: 4, retryable: false });
        await putStage(trackId, "embedding", "pending");

        await closeOrphanedDependents();

        const rec = await getRecord(trackId, "embedding");
        expect(rec.status).toBe("failed");
        expect(rec.failureClass).toBe("DEPENDENCY_CLOSED");
        expect(rec.startedAt).toBeTruthy();
        expect(rec.finishedAt).toBeTruthy();
    });
});

describe("waiting is not failing", () => {
    /** A fresh claim, as dispatch makes one: a new attempt names it, nothing else changes. */
    async function claim(trackId: string): Promise<string> {
        const [row] = await prisma.$queryRawUnsafe<Array<{ attempt: number }>>(
            `UPDATE "TrackStage" SET status = 'working', attempt = attempt + 1, redelivered = 0, "startedAt" = now()
              WHERE "trackId" = $1 AND stage = 'recording' RETURNING attempt`,
            trackId,
        );
        return `track-${trackId}-recording-${row.attempt}-r0`;
    }

    it("waits on a paused source and fresh claims use up no retry; four reported failures close it", async () => {
        const trackId = id("waits");
        await seedTrack(trackId, { recording: { status: "pending", attempt: 0 } });
        const paused = Object.assign(new Error("HTTP 429 Too Many Requests"), { response: { status: 429 } });

        for (let wait = 0; wait < 6; wait++) {
            await recordStageFailure(trackId, "recording", "musicbrainz", paused, {}, await claim(trackId));
            const rec = await getRecord(trackId, "recording");
            expect(rec.status).toBe("pending");
            expect(rec.failures).toBe(0);
        }

        for (let failures = 1; failures <= STAGE_RETRY_CAP; failures++) {
            await recordStageFailure(trackId, "recording", "musicbrainz", new Error("socket hang up"), {}, await claim(trackId));
            const rec = await getRecord(trackId, "recording");
            expect(rec.failures).toBe(failures);
            expect(rec.retryable).toBe(failures < STAGE_RETRY_CAP);
        }
        // Every claim had its own name: six waits and four failures, ten attempts.
        expect((await getRecord(trackId, "recording")).attempt).toBe(10);
    });
});
