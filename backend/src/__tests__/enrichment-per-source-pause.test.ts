/**
 * While a source is paused, getNextWork offers none of its stage's work. A rate
 * limit pauses only that source, and the record waits as pending without
 * spending an attempt.
 */

import { prisma } from "../utils/db";
import { sourcePauseController } from "../services/sourcePauseController";
import { getNextWork, recordStageFailure, syncWaitingAlerts } from "../workers/unifiedEnrichment";
import { closeEngineConnections } from "./helpers/engineConnections";

const PREFIX = "pause";
const id = (n: string) => `${PREFIX}_${n}`;

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: { attempt?: number; retryable?: boolean; nextRetryAt?: Date | null; source?: string } = {},
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, "nextRetryAt", evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                source = EXCLUDED.source,
                attempt = EXCLUDED.attempt,
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence`,
        `${trackId}__${stage}`, trackId, stage, status, opts.source ?? "musicbrainz",
        opts.attempt ?? 0, opts.retryable ?? true, opts.nextRetryAt ?? null,
        JSON.stringify({ probe: "mb-search", rc: 1 }),
    );
}

/** A: recording owed (musicbrainz). B: recording done, analysis owed (analyzer). */
async function seedChain(): Promise<void> {
    // FK chain
    await prisma.artist.create({
        data: { id: id("art"), name: "Pause Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Pause Album", primaryType: "Album" },
    });
    for (const suffix of ["a", "b"]) {
        await prisma.track.create({
            data: {
                id: id(suffix),
                albumId: id("alb"),
                title: `Track ${suffix}`,
                trackNo: 1,
                duration: 180,
                filePath: `/tmp/${suffix}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
                analysisStatus: "pending",
            },
        });
    }
    await putStage(id("a"), "recording", "pending");
    await putStage(id("b"), "recording", "done", { attempt: 1 });
    await putStage(id("b"), "analysis", "pending", { source: "analyzer" });
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
    for (const source of ["musicbrainz", "analyzer", "clap"]) {
        await prisma.$executeRawUnsafe(`DELETE FROM "SourceAttempt" WHERE source = $1`, source);
    }
    await prisma.notification.deleteMany({ where: { userId: id("admin") } });
    await prisma.user.deleteMany({ where: { id: id("admin") } });
}

beforeEach(async () => {
    await wipe();
    await seedChain();
});

afterAll(async () => {
    await wipe();
    await closeEngineConnections();
});

describe("the dequeuer consults the pause before handing out work", () => {
    it("offers recording and analysis work with nothing paused", async () => {
        const offered = await getNextWork(10);
        expect(offered.map((w) => w.trackId)).toEqual(
            expect.arrayContaining([id("a"), id("b")]),
        );
    });

    it("does not offer recording work while musicbrainz is paused", async () => {
        await sourcePauseController.pause("musicbrainz", {
            until: new Date(Date.now() + 60_000),
            code: "RATE_LIMITED",
            message: "MusicBrainz 503",
        });

        const offered = await getNextWork(10);
        // While musicbrainz is paused, track a's RECORDING record is not
        // offered — its remaining questions (the local fingerprint sweep and
        // the file-only analysis) are different records on different sources,
        // which a paused network source must never block.
        expect(
            offered.filter((w) => w.stage !== "fingerprint" && w.stage !== "analysis").map((w) => w.trackId),
        ).not.toContain(id("a"));
        // The paused source's stage is skipped entirely — nothing owed for it.
        expect(offered.filter((w) => w.stage === "recording")).toEqual([]);
    });

    it("still offers analysis and embedding while only musicbrainz is paused", async () => {
        await sourcePauseController.pause("musicbrainz", {
            until: new Date(Date.now() + 60_000),
            code: "RATE_LIMITED",
            message: "MusicBrainz 503",
        });

        const offered = await getNextWork(10);
        // B's recording is answered (done) so its owed stage is analysis —
        // that must still be offered despite musicbrainz sleeping.
        expect(offered.map((w) => w.trackId)).toContain(id("b"));
        expect(offered.find((w) => w.trackId === id("b"))?.stage).toBe("analysis");
    });

    it("a pause that has elapsed is not a pause", async () => {
        await sourcePauseController.pause("musicbrainz", {
            until: new Date(Date.now() - 1000),
            code: "RATE_LIMITED",
            message: "expired",
        });
        expect(await sourcePauseController.isPaused("musicbrainz")).toBe(false);
        const offered = await getNextWork(10);
        expect(offered.map((w) => w.trackId)).toContain(id("a"));
    });

    it("deleting the pause row lifts it and work is offered again", async () => {
        await sourcePauseController.pause("musicbrainz", {
            until: new Date(Date.now() + 60_000),
            code: "RATE_LIMITED",
            message: "MusicBrainz 503",
        });
        await prisma.sourceAttempt.deleteMany({ where: { source: "musicbrainz" } });
        expect(await sourcePauseController.isPaused("musicbrainz")).toBe(false);
        const offered = await getNextWork(10);
        expect(offered.map((w) => w.trackId)).toContain(id("a"));
    });
});

describe("a rate limit pauses only that source and is not a failure", () => {
    it("a 429 error pauses musicbrainz, leaves the other sources running", async () => {
        const err = Object.assign(new Error("Request failed with status code 429"), {
            response: { status: 429 },
        });
        await recordStageFailure(id("a"), "recording", "musicbrainz", err);

        expect(await sourcePauseController.isPaused("musicbrainz")).toBe(true);
        expect(await sourcePauseController.isPaused("analyzer")).toBe(false);
        expect(await sourcePauseController.isPaused("clap")).toBe(false);
        expect(await sourcePauseController.listPaused()).toEqual(["musicbrainz"]);
    });

    it("the waiting record names the source that was limited, not the one it was last asked of", async () => {
        await putStage(id("a"), "recording", "working", { attempt: 1, source: "acoustid" });

        const err = Object.assign(new Error("HTTP 429 Too Many Requests"), { response: { status: 429 } });
        await recordStageFailure(id("a"), "recording", "musicbrainz", err);

        // The dispatch checks the stored source's pause, so it must be the paused one.
        expect((await getRecord(id("a"), "recording")).source).toBe("musicbrainz");
    });

    it("the record waits instead of failing: attempt unchanged, back to pending", async () => {
        await putStage(id("a"), "recording", "working", { attempt: 1 });

        const err = Object.assign(new Error("HTTP 429 Too Many Requests"), {
            response: { status: 429 },
        });
        await recordStageFailure(id("a"), "recording", "musicbrainz", err);

        const rec = await getRecord(id("a"), "recording");
        // Not counted as a failure: the attempt stays where it was and the
        // record is re-queued (`pending`), due when the pause lifts.
        expect(rec.attempt).toBe(1);
        expect(rec.status).toBe("pending");
        expect(new Date(rec.nextRetryAt).getTime()).toBeGreaterThan(Date.now());

        // While musicbrainz is paused the RECORDING record is not offered.
        // (The track's local fingerprint question and its file-only analysis
        // question are different records on different sources and stay
        // available — a paused network source never blocks the sweep.)
        const offered = await getNextWork(10);
        expect(
            offered.filter((w) => w.stage === "recording").map((w) => w.trackId),
        ).not.toContain(id("a"));
    });

    it("a MusicBrainz 503 also pauses the source", async () => {
        const mb503 = Object.assign(new Error("Service Unavailable"), {
            response: { status: 503 },
        });
        await recordStageFailure(id("a"), "recording", "musicbrainz", mb503);
        expect(await sourcePauseController.isPaused("musicbrainz")).toBe(true);
    });
});

describe("a source that keeps enrichment waiting for a day", () => {
    const tooMany = () => Object.assign(new Error("HTTP 429 Too Many Requests"), { response: { status: 429 } });
    const alerts = () => prisma.notification.findMany({ where: { userId: id("admin") } });

    beforeEach(async () => {
        await prisma.user.create({
            data: { id: id("admin"), username: id("admin"), passwordHash: "x", role: "admin", tokenVersion: 0 },
        });
        await putStage(id("b"), "recording", "pending");
        const dayAgo = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" SET evidence = jsonb_build_object('waitingSince', $1::text)
              WHERE "trackId" IN ($2, $3) AND stage = 'recording'`,
            dayAgo, id("a"), id("b"),
        );
    });

    it("raises one alert for the source, not one per track", async () => {
        await recordStageFailure(id("a"), "recording", "musicbrainz", tooMany());
        await recordStageFailure(id("b"), "recording", "musicbrainz", tooMany());

        const rows = await alerts();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ title: "Enrichment waiting on musicbrainz", groupKey: "enrichment-waiting:musicbrainz" });
    });

    it("removes the alert once nothing waits on the source", async () => {
        await recordStageFailure(id("a"), "recording", "musicbrainz", tooMany());
        await syncWaitingAlerts();
        expect(await alerts()).toHaveLength(1);

        await putStage(id("a"), "recording", "done", { attempt: 1 });
        await syncWaitingAlerts();
        expect(await alerts()).toHaveLength(0);
    });
});
