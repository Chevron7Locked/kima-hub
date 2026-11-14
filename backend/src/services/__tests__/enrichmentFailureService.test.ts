/**
 * recordFailure upserts atomically and clears the resolved state on a repeat failure.
 * Real database.
 */

import { enrichmentFailureService } from "../enrichmentFailureService";
import { STAGE_RETRY_CAP } from "../../workers/stageRetry";
import { prisma } from "../../utils/db";

const P = "zz-enrichmentFailure-";

async function wipe() {
    await prisma.enrichmentFailure.deleteMany({ where: { entityId: { startsWith: P } } });
}
const stored = (entityId: string) =>
    prisma.enrichmentFailure.findUnique({ where: { entityType_entityId: { entityType: "artist", entityId } } });

beforeAll(wipe);
beforeEach(wipe);
afterAll(wipe);

describe("EnrichmentFailureService", () => {
    describe("recordFailure", () => {
        const baseInput = {
            entityType: "artist" as const,
            entityId: `${P}artist-123`,
            entityName: "Test Track",
            errorMessage: "Analysis failed: timeout",
            errorCode: "MAX_RETRIES_EXCEEDED",
            metadata: { filePath: "/music/test.flac" },
        };

        // An artist is retried until STAGE_RETRY_CAP (workers/enrichment/artists.ts), the cap stage records show too.
        it("stores a first failure with retryCount 1 and maxRetries STAGE_RETRY_CAP", async () => {
            await enrichmentFailureService.recordFailure(baseInput);

            expect(await stored(baseInput.entityId)).toMatchObject({
                entityName: "Test Track",
                errorMessage: "Analysis failed: timeout",
                errorCode: "MAX_RETRIES_EXCEEDED",
                retryCount: 1,
                maxRetries: STAGE_RETRY_CAP,
                resolved: false,
                metadata: { filePath: "/music/test.flac" },
            });
        });

        it("a repeat failure of the same entity updates the one row and increments retryCount", async () => {
            await enrichmentFailureService.recordFailure(baseInput);
            await enrichmentFailureService.recordFailure({ ...baseInput, errorMessage: "second try" });

            const rows = await prisma.enrichmentFailure.findMany({ where: { entityId: baseInput.entityId } });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ retryCount: 2, errorMessage: "second try" });
        });

        it("a repeat failure refreshes maxRetries, so a changed cap reaches an old row", async () => {
            await enrichmentFailureService.recordFailure(baseInput);
            await prisma.enrichmentFailure.update({
                where: { entityType_entityId: { entityType: "artist", entityId: baseInput.entityId } },
                data: { maxRetries: 1 },
            });

            await enrichmentFailureService.recordFailure(baseInput);

            expect(await stored(baseInput.entityId)).toMatchObject({ maxRetries: STAGE_RETRY_CAP, retryCount: 2 });
        });

        it("takes only ledger types: a song's failure is its stage record", () => {
            // @ts-expect-error a song stage's type is not a ledger type
            const song: Parameters<typeof enrichmentFailureService.recordFailure>[0] = { ...baseInput, entityType: "audio" };
            expect(song.entityType).toBe("audio");
        });

        it("a repeat failure that names no code does not keep the earlier failure's code", async () => {
            await enrichmentFailureService.recordFailure(baseInput);
            await enrichmentFailureService.recordFailure({ ...baseInput, errorCode: undefined, errorMessage: "another way" });

            expect(await stored(baseInput.entityId)).toMatchObject({ errorCode: null, errorMessage: "another way" });
        });

        it("a repeat failure records the entity's current name", async () => {
            await enrichmentFailureService.recordFailure(baseInput);
            await enrichmentFailureService.recordFailure({ ...baseInput, entityName: "Renamed Artist" });

            expect(await stored(baseInput.entityId)).toMatchObject({ entityName: "Renamed Artist", retryCount: 2 });
        });

        it("a repeat failure with no metadata keeps the stored metadata", async () => {
            await enrichmentFailureService.recordFailure(baseInput);
            await enrichmentFailureService.recordFailure({ ...baseInput, metadata: undefined });

            expect(await stored(baseInput.entityId)).toMatchObject({ metadata: { filePath: "/music/test.flac" } });
        });

        it("two failures recorded at once make one row, not a unique-key error", async () => {
            await Promise.all([
                enrichmentFailureService.recordFailure(baseInput),
                enrichmentFailureService.recordFailure(baseInput),
            ]);

            const rows = await prisma.enrichmentFailure.findMany({ where: { entityId: baseInput.entityId } });
            expect(rows).toHaveLength(1);
            expect(rows[0].retryCount).toBe(2);
        });

        it("a repeat failure clears resolved and skipped", async () => {
            await enrichmentFailureService.recordFailure(baseInput);
            await prisma.enrichmentFailure.update({
                where: { entityType_entityId: { entityType: "artist", entityId: baseInput.entityId } },
                data: { resolved: true, resolvedAt: new Date(), skipped: true, skippedAt: new Date() },
            });

            await enrichmentFailureService.recordFailure(baseInput);

            expect(await stored(baseInput.entityId)).toMatchObject({
                resolved: false,
                resolvedAt: null,
                skipped: false,
                skippedAt: null,
            });
        });

        it("serializes metadata, and a repeat with new metadata replaces it", async () => {
            const metadata = { filePath: "/music/test.flac", nested: { key: "val" } };
            await enrichmentFailureService.recordFailure({ ...baseInput, metadata });
            expect((await stored(baseInput.entityId))?.metadata).toEqual(metadata);

            await enrichmentFailureService.recordFailure({ ...baseInput, metadata: { filePath: "/music/other.flac" } });
            expect((await stored(baseInput.entityId))?.metadata).toEqual({ filePath: "/music/other.flac" });
        });

        it("stores no metadata when none is given, and a repeat without metadata keeps what was stored", async () => {
            const id = `${P}artist-456`;
            const input = { entityType: "artist" as const, entityId: id, errorMessage: "MusicBrainz timeout" };

            await enrichmentFailureService.recordFailure(input);
            expect((await stored(id))?.metadata).toBeNull();

            await enrichmentFailureService.recordFailure({ ...input, metadata: { kept: true } });
            await enrichmentFailureService.recordFailure(input);
            expect((await stored(id))?.metadata).toEqual({ kept: true });
        });
    });

    describe("cleanupOrphanedFailures", () => {
        const failure = (entityType: string, entityId: string) =>
            prisma.enrichmentFailure.create({ data: { entityType, entityId, errorMessage: "x", maxRetries: STAGE_RETRY_CAP } });
        const open = (entityType: string, entityId: string) =>
            prisma.enrichmentFailure.count({ where: { entityType, entityId, resolved: false } });

        afterEach(async () => {
            await prisma.track.deleteMany({ where: { id: `${P}track` } });
            await prisma.album.deleteMany({ where: { id: `${P}album` } });
            await prisma.artist.deleteMany({ where: { id: `${P}artist-real` } });
        });

        it("resolves a row whose artist or podcast is gone and keeps one whose subject exists", async () => {
            await prisma.artist.create({
                data: { id: `${P}artist-real`, name: "Real", normalizedName: "real", identityKey: `${P}ik-real`, mbid: null },
            });
            await failure("artist", `${P}artist-real`);
            await failure("artist", `${P}artist-gone`);
            await failure("podcast", `${P}podcast-gone`);

            await enrichmentFailureService.cleanupOrphanedFailures();

            expect(await open("artist", `${P}artist-real`)).toBe(1);
            expect(await open("artist", `${P}artist-gone`)).toBe(0);
            expect(await open("podcast", `${P}podcast-gone`)).toBe(0);
        });

        it("leaves a legacy audio or vibe row for a song that has since analysed", async () => {
            await prisma.artist.create({
                data: { id: `${P}artist-real`, name: "Real", normalizedName: "real", identityKey: `${P}ik-real`, mbid: null },
            });
            await prisma.album.create({
                data: { id: `${P}album`, rgMbid: `${P}rg`, artistId: `${P}artist-real`, identityKey: `${P}ik-al`, title: "A", primaryType: "Album", location: "LIBRARY" },
            });
            await prisma.track.create({
                data: {
                    id: `${P}track`, albumId: `${P}album`, title: "T", trackNo: 1, duration: 1, filePath: `${P}t.flac`,
                    fileModified: new Date(), fileSize: 1, analysisStatus: "completed", vibeAnalysisStatus: "completed",
                },
            });
            await failure("audio", `${P}track`);
            await failure("vibe", `${P}track`);

            await enrichmentFailureService.cleanupOrphanedFailures();

            // Nothing writes these types any more; the sweep no longer reads the song's status columns for them.
            expect(await open("audio", `${P}track`)).toBe(1);
            expect(await open("vibe", `${P}track`)).toBe(1);
        });
    });
});
