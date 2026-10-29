/**
 * A sound-vector record closed because its analysis failed for good reopens
 * when that analysis is later answered. Closing a missing file's records also
 * updates the Track status columns that mirror them.
 */

import { prisma } from "../utils/db";
import { closeOrphanedDependents, recordStageSuccess } from "../workers/unifiedEnrichment";
import { closeStagesForMissingTracks } from "../services/missingFileStages";
import { closeEngineConnections } from "./helpers/engineConnections";

const PREFIX = "depreopen";
const id = (n: string) => `${PREFIX}_${n}`;

async function putStage(trackId: string, stage: string, status: string, retryable: boolean, failureClass: string | null = null) {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, "failureClass")
         VALUES ($1, $2, $3, $4, 'analyzer', 1, $5, $6)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status, retryable = EXCLUDED.retryable, "failureClass" = EXCLUDED."failureClass"`,
        `${trackId}__${stage}`, trackId, stage, status, retryable, failureClass,
    );
}

async function record(trackId: string, stage: string) {
    const [row] = await prisma.$queryRawUnsafe<any[]>(
        `SELECT status, "failureClass", retryable FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`, trackId, stage,
    );
    return row;
}

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    await wipe();
    await prisma.artist.create({ data: { id: id("art"), name: "Dep Artist", identityKey: id("a") } });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Dep Album", primaryType: "Album" },
    });
    for (const [t, missing] of [["t", false], ["gone", true]] as const) {
        await prisma.track.create({
            data: {
                id: id(t), albumId: id("alb"), title: t, trackNo: 1, duration: 180, filePath: `/tmp/${t}.flac`,
                fileModified: new Date(), fileSize: 1, analysisStatus: "processing",
                vibeAnalysisStatus: "pending", ...(missing ? { missingSince: new Date() } : {}),
            },
        });
    }
});

afterAll(async () => {
    await wipe();
    await closeEngineConnections();
});

describe("a closed dependency that is later answered", () => {
    it("reopens the sound-vector record it had closed", async () => {
        await putStage(id("t"), "analysis", "failed", false, "PERMANENT");
        await putStage(id("t"), "embedding", "pending", true);
        await closeOrphanedDependents();
        expect(await record(id("t"), "embedding")).toMatchObject({ status: "failed", failureClass: "DEPENDENCY_CLOSED" });

        await recordStageSuccess(id("t"), "analysis", "analyzer", { answer: "completed" });
        expect(await record(id("t"), "embedding")).toMatchObject({ status: "pending", failureClass: null, retryable: true });
    });
});

describe("a closed fingerprint", () => {
    it("leaves identification open: it waits for the fingerprint to settle, not for its output", async () => {
        await putStage(id("t"), "fingerprint", "failed", false, "PERMANENT");
        await putStage(id("t"), "recording", "pending", true);
        await closeOrphanedDependents();
        expect(await record(id("t"), "recording")).toMatchObject({ status: "pending", retryable: true });
    });
});

describe("closing a missing file's records", () => {
    it("closes the open records and mirrors them on the Track", async () => {
        await putStage(id("gone"), "analysis", "pending", true);
        await putStage(id("gone"), "embedding", "pending", true);
        const closed = await closeStagesForMissingTracks(prisma);
        expect(closed).toBe(2);
        expect(await record(id("gone"), "analysis")).toMatchObject({ status: "failed", failureClass: "FILE_MISSING" });
        const t = await prisma.track.findUniqueOrThrow({ where: { id: id("gone") } });
        expect(t.analysisStatus).toBe("permanently_failed");
        expect(t.vibeAnalysisStatus).toBe("permanently_failed");
    });

    it("leaves present files alone", async () => {
        await putStage(id("t"), "analysis", "pending", true);
        expect(await closeStagesForMissingTracks(prisma)).toBe(0);
        expect(await record(id("t"), "analysis")).toMatchObject({ status: "pending" });
    });
});
