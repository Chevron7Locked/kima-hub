/**
 * The failures API reads track-stage failures from TrackStage and keeps
 * EnrichmentFailure for artists and podcasts only, in the same response shape
 * the frontend reads.
 */

const mockRedis = {
    publish: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    set: jest.fn().mockResolvedValue("OK"),
    rpush: jest.fn().mockResolvedValue(1),
    llen: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    keys: jest.fn().mockResolvedValue([]),
    status: "ready",
};
jest.mock("ioredis", () => jest.fn(() => mockRedis));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { enrichmentFailureService } from "../enrichmentFailureService";
import { recordStageSuccess } from "../../workers/unifiedEnrichment";

const PREFIX = "fstrk";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedTrack(trackId: string): Promise<void> {
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
}

async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: {
        source?: string;
        attempt?: number;
        error?: string;
        errorCode?: string;
        failureClass?: string;
        retryable?: boolean;
    } = {},
): Promise<string> {
    const stageId = `${trackId}__${stage}`;
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, failures,
             "lastErrorCode", "lastErrorMessage", "failureClass",
             retryable, evidence, "startedAt", "finishedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11::jsonb, now(), now())
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                source = EXCLUDED.source,
                attempt = EXCLUDED.attempt,
                failures = EXCLUDED.failures,
                "lastErrorCode" = EXCLUDED."lastErrorCode",
                "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                "failureClass" = EXCLUDED."failureClass",
                retryable = EXCLUDED.retryable,
                evidence = EXCLUDED.evidence,
                "startedAt" = now(),
                "finishedAt" = now()`,
        stageId,
        trackId,
        stage,
        status,
        opts.source ?? "analyzer",
        opts.attempt ?? 1,
        opts.errorCode ?? "INCONCLUSIVE",
        opts.error ?? "Analysis failed: decoder overrun",
        opts.failureClass ?? "INCONCLUSIVE",
        opts.retryable ?? true,
        JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
    );
    return stageId;
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(
        `DELETE FROM "EnrichmentFailure" WHERE "entityId" LIKE $1 OR "entityName" LIKE $2`,
        `${PREFIX}_%`,
        `${PREFIX}_%`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    await wipe();
    await prisma.artist.create({
        data: { id: id("art"), name: "Failures Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: {
            id: id("alb"), rgMbid: id("rg"), artistId: id("art"),
            title: "Failures Album", primaryType: "Album",
        },
    });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("getFailures reads track stages from TrackStage", () => {
    it("surfaces a failed recording stage in the exact EnrichmentFailure shape", async () => {
        const trackId = id("rec");
        await seedTrack(trackId);
        const stageId = await putStage(trackId, "recording", "failed", {
            source: "musicbrainz",
            attempt: 2,
            error: "MusicBrainz search found nothing",
            errorCode: "INCONCLUSIVE",
        });

        const { failures, total } = await enrichmentFailureService.getFailures({
            entityType: "track",
        });

        const entry = failures.find((f) => f.entityId === trackId);
        expect(entry).toBeDefined();
        // Both counts are whole dispatches: 2 so far, 4 allowed (initial + 3
        // ladder rungs), so the UI reads "2 of 4".
        expect(entry).toMatchObject({
            id: stageId,
            entityType: "track",
            entityId: trackId,
            entityName: `Track ${trackId}`,
            errorMessage: "MusicBrainz search found nothing",
            retryCount: 2,
            maxRetries: 4,
            resolved: false,
            skipped: false,
        });
        expect(entry!.lastFailedAt).toBeTruthy();
        expect(total).toBeGreaterThanOrEqual(1);
    });

    it("surfaces analysis, embedding and fingerprint stages too", async () => {
        const audio = id("aud");
        const vibe = id("vib");
        const scan = id("scn");
        await seedTrack(audio);
        await seedTrack(vibe);
        await seedTrack(scan);
        await putStage(audio, "analysis", "failed", { error: "decode overrun" });
        await putStage(vibe, "embedding", "failed", { error: "CLAP worker died" });
        await putStage(scan, "fingerprint", "failed", { error: "fpcalc exited 3" });

        const audioList = await enrichmentFailureService.getFailures({ entityType: "audio" });
        const vibeList = await enrichmentFailureService.getFailures({ entityType: "vibe" });
        const scanList = await enrichmentFailureService.getFailures({ entityType: "scan" });

        expect(audioList.failures.map((f) => f.entityId)).toContain(audio);
        expect(vibeList.failures.map((f) => f.entityId)).toContain(vibe);
        expect(scanList.failures.map((f) => f.entityId)).toContain(scan);
    });

    it("a type it does not know lists nothing, even one named like a built-in object key", async () => {
        const song = id("unk");
        await seedTrack(song);
        await putStage(song, "recording", "failed", { error: "x" });
        for (const entityType of ["nonsense", "constructor", "toString", "__proto__"]) {
            await expect(enrichmentFailureService.getFailures({ entityType } as never)).resolves.toEqual({ failures: [], total: 0 });
        }
    });

    it("getFailure resolves a TrackStage id to the mapped failure", async () => {
        const trackId = id("one");
        await seedTrack(trackId);
        const stageId = await putStage(trackId, "analysis", "failed", {
            error: "Essentia timed out",
        });

        const failure = await enrichmentFailureService.getFailure(stageId);

        expect(failure).not.toBeNull();
        expect(failure).toMatchObject({
            id: stageId,
            entityType: "audio",
            entityId: trackId,
            errorMessage: "Essentia timed out",
        });
    });
});

describe("getFailureCounts reads track stages from TrackStage", () => {
    it("counts each track stage in its bucket and keeps artist from EnrichmentFailure", async () => {
        const trackId = id("cnt");
        await seedTrack(trackId);
        await putStage(trackId, "recording", "failed", { error: "no match" });
        await putStage(trackId, "analysis", "failed", { error: "decode overrun" });
        await prisma.enrichmentFailure.create({
            data: {
                id: `artist:${id("artfail")}`,
                entityType: "artist",
                entityId: id("artfail"),
                entityName: "Some Artist",
                errorMessage: "Wikidata timeout",
                errorCode: "NETWORK",
                retryCount: 1,
                maxRetries: 3,
                lastFailedAt: new Date(),
            },
        });

        const counts = await enrichmentFailureService.getFailureCounts();

        expect(counts.track).toBe(1);
        expect(counts.audio).toBe(1);
        expect(counts.vibe).toBe(0);
        expect(counts.artist).toBe(1);
        expect(counts.total).toBe(3);
    });
});

describe("one record per fact: success clears the failure with no second ledger", () => {
    it("a stage that later succeeds disappears from the list with zero EnrichmentFailure writes", async () => {
        const trackId = id("heal");
        await seedTrack(trackId);
        await putStage(trackId, "recording", "failed", { error: "no match", attempt: 1 });

        const before = await enrichmentFailureService.getFailureCounts();
        expect(before.track).toBe(1);

        // The engine's real success path settles the TrackStage record...
        await recordStageSuccess(trackId, "recording", "musicbrainz", {
            recordingMbid: "mb-1",
        });

        const after = await enrichmentFailureService.getFailureCounts();
        expect(after.track).toBe(0);
        const list = await enrichmentFailureService.getFailures({ entityType: "track" });
        expect(list.failures.map((f) => f.entityId)).not.toContain(trackId);

        // ...and nothing was written to the failure ledger for this track.
        const ledgerRows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "EnrichmentFailure"
              WHERE "entityId" = $1`,
            trackId,
        );
        expect(Number(ledgerRows[0]?.n ?? 0)).toBe(0);
    });
});

describe("entities without a TrackStage keep using EnrichmentFailure", () => {
    it("artist failures still surface from the old ledger", async () => {
        const created = await enrichmentFailureService.recordFailure({
            entityType: "artist",
            entityId: id("artist2"),
            entityName: "Ledger Artist",
            errorMessage: "ListenBrainz timeout",
            errorCode: "NETWORK",
        });

        const { failures } = await enrichmentFailureService.getFailures({
            entityType: "artist",
        });

        expect(failures.map((f) => f.entityId)).toContain(id("artist2"));
        const failure = await enrichmentFailureService.getFailure(created.id);
        expect(failure).not.toBeNull();
        expect(failure!.entityType).toBe("artist");
    });
});
