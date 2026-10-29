/**
 * Reports name the attempt they answer. A report for an answered record, or for
 * an attempt other than the open claim, changes nothing; the open claim's own
 * report settles the record. The shared valence/arousal pair is derived from
 * both analyzers' raw answers whenever either settles.
 */

import { prisma } from "../utils/db";
import {
    claimIsCurrent,
    claimOf,
    reconcileStaleStageRecords,
    recordStageFailure,
    recordStageSuccess,
} from "../workers/unifiedEnrichment";
import { closeEngineConnections } from "./helpers/engineConnections";

const PREFIX = "stalerep";
const id = (n: string) => `${PREFIX}_${n}`;

/** A stage row as the migrations made most of them: its id is not "<track>__<stage>", so nothing may find it by that. */
async function putStage(trackId: string, stage: string, status: string, attempt: number, redelivered = 0) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, redelivered, retryable, "startedAt")
         VALUES (md5(random()::text), $1, $2, $3, 'clap', $4, $5, true, now())
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status, attempt = EXCLUDED.attempt, redelivered = EXCLUDED.redelivered`,
        trackId, stage, status, attempt, redelivered,
    );
}

async function record(trackId: string, stage: string) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT status, attempt, retryable FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`, trackId, stage,
    );
    return rows[0];
}

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    await wipe();
    await prisma.artist.create({ data: { id: id("art"), name: "Stale Artist", identityKey: id("a") } });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Stale Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: id("t"), albumId: id("alb"), title: "T", trackNo: 1, duration: 180,
            filePath: "/tmp/t.flac", fileModified: new Date(), fileSize: 1,
        },
    });
});

afterAll(async () => {
    await wipe();
    await closeEngineConnections();
});

describe("a sound-vector claim with no answer yet", () => {
    it("keeps its lease: a worker that is only down or slow uses up no redelivery", async () => {
        await putStage(id("t"), "embedding", "working", 3, 1);
        await prisma.$executeRawUnsafe(
            `UPDATE "TrackStage" SET "startedAt" = now() - interval '5 minutes', "nextRetryAt" = now() + interval '10 minutes'
              WHERE "trackId" = $1 AND stage = 'embedding'`,
            id("t"),
        );

        await reconcileStaleStageRecords("embedding");

        const rows = await prisma.$queryRawUnsafe<any[]>(
            `SELECT status, attempt, redelivered, "nextRetryAt" <= now() AS due FROM "TrackStage" WHERE "trackId" = $1 AND stage = 'embedding'`,
            id("t"),
        );
        expect(rows[0]).toEqual({ status: "working", attempt: 3, redelivered: 1, due: false });
    });
});

describe("which attempt a report answers", () => {
    it("reads attempt and redelivery from the per-attempt job id", () => {
        expect(claimOf("vibe-abc-3-r1")).toEqual({ attempt: 3, redelivered: 1 });
        expect(claimOf("cmu698min07r3gbzb-2-r0")).toEqual({ attempt: 2, redelivered: 0 });
        expect(claimOf(undefined)).toBeNull();
        expect(claimOf("no-claim-here")).toBeNull();
    });
});

describe("a job whose claim was re-issued", () => {
    it("does no work; the open claim's job does", async () => {
        await putStage(id("t"), "recording", "working", 3);
        expect(await claimIsCurrent(id("t"), "recording", "track-x-recording-2-r0")).toBe(false);
        expect(await claimIsCurrent(id("t"), "recording", "track-x-recording-3-r0")).toBe(true);
        expect(await claimIsCurrent(id("t"), "recording", "track-x-recording-3-r1")).toBe(false);
    });

    it("a finished record has no current claim; a job id with no claim always runs", async () => {
        await putStage(id("t"), "recording", "done", 3);
        expect(await claimIsCurrent(id("t"), "recording", "track-x-recording-3-r0")).toBe(false);
        expect(await claimIsCurrent(id("t"), "recording", "manual-retry")).toBe(true);
    });
});

describe("a late failure", () => {
    it("never reopens a finished record", async () => {
        await putStage(id("t"), "embedding", "done", 1);
        await recordStageFailure(id("t"), "embedding", "clap", new Error("socket hang up"));
        expect(await record(id("t"), "embedding")).toMatchObject({ status: "done" });
    });

    it("for an earlier attempt leaves the open claim alone", async () => {
        await putStage(id("t"), "embedding", "working", 2);
        await recordStageFailure(id("t"), "embedding", "clap", new Error("socket hang up"), {}, "vibe-x-1-r0");
        expect(await record(id("t"), "embedding")).toMatchObject({ status: "working", attempt: 2 });
    });

    it("for the open claim settles it", async () => {
        await putStage(id("t"), "embedding", "working", 2);
        await recordStageFailure(id("t"), "embedding", "clap", new Error("socket hang up"), {}, "vibe-x-2-r0");
        expect(await record(id("t"), "embedding")).toMatchObject({ status: "failed", attempt: 2, retryable: true });
    });

    it("from a delivery the lease already replaced leaves the replacement alone", async () => {
        await putStage(id("t"), "analysis", "working", 1, 1);
        await recordStageFailure(id("t"), "analysis", "analyzer", new Error("decode failed"), {}, "an-x-1-r0");
        expect(await record(id("t"), "analysis")).toMatchObject({ status: "working" });
    });
});

describe("a late success", () => {
    it("for an earlier attempt leaves the open claim alone", async () => {
        await putStage(id("t"), "embedding", "working", 3);
        await recordStageSuccess(id("t"), "embedding", "clap", { outcome: "embedded" }, "vibe-x-2-r0");
        expect(await record(id("t"), "embedding")).toMatchObject({ status: "working", attempt: 3 });
        const t = await prisma.track.findUniqueOrThrow({ where: { id: id("t") } });
        expect(t.vibeAnalysisStatus).not.toBe("completed");
    });

    it("for the open claim settles it and mirrors the status", async () => {
        await putStage(id("t"), "embedding", "working", 3);
        await recordStageSuccess(id("t"), "embedding", "clap", { outcome: "embedded" }, "vibe-x-3-r0");
        expect(await record(id("t"), "embedding")).toMatchObject({ status: "done" });
        const t = await prisma.track.findUniqueOrThrow({ where: { id: id("t") } });
        expect(t.vibeAnalysisStatus).toBe("completed");
    });
});

describe("the shared valence/arousal pair", () => {
    it("is the analysis answer alone until the sound vector has answered, then the blend", async () => {
        await prisma.track.update({ where: { id: id("t") }, data: { deamValence: 0.8, deamArousal: 0.4 } });
        await putStage(id("t"), "analysis", "working", 1);
        await recordStageSuccess(id("t"), "analysis", "analyzer", {}, "an-x-1-r0");
        let t = await prisma.track.findUniqueOrThrow({ where: { id: id("t") } });
        expect(t.valence).toBeCloseTo(0.8, 6);
        expect(t.arousal).toBeCloseTo(0.4, 6);

        await prisma.track.update({ where: { id: id("t") }, data: { clapValenceRaw: 0.2, clapArousalRaw: 0.6 } });
        await putStage(id("t"), "embedding", "working", 1);
        await recordStageSuccess(id("t"), "embedding", "clap", {}, "vibe-x-1-r0");
        t = await prisma.track.findUniqueOrThrow({ where: { id: id("t") } });
        expect(t.valence).toBeCloseTo(0.7 * 0.8 + 0.3 * 0.2, 3);
        expect(t.arousal).toBeCloseTo(0.5 * 0.4 + 0.5 * 0.6, 3);
    });

    it("survives a re-analysis: the blend is recomputed, not replaced by the analysis answer", async () => {
        await prisma.track.update({
            where: { id: id("t") },
            data: { deamValence: 0.5, deamArousal: 0.5, clapValenceRaw: 0.1, clapArousalRaw: 0.9 },
        });
        await putStage(id("t"), "analysis", "working", 2);
        await recordStageSuccess(id("t"), "analysis", "analyzer", {}, "an-x-2-r0");
        const t = await prisma.track.findUniqueOrThrow({ where: { id: id("t") } });
        expect(t.valence).toBeCloseTo(0.7 * 0.5 + 0.3 * 0.1, 3);
        expect(t.arousal).toBeCloseTo(0.5 * 0.5 + 0.5 * 0.9, 3);
    });
});
