/**
 * buildFinalPlaylist links each Discover album to the download job that fetched it, so the suggestion records the
 * Lidarr album id Discover's clear later deletes by. Lidarr's names keep accents and typographic marks the scanned
 * names may lack (pairs recorded from a production library), so the link compares names by sameName.
 * Real database; the stored suggestion's Lidarr id is what is checked.
 */
import { discoverWeeklyService } from "../../discoverWeekly";
import { prisma } from "../../../utils/db";
import { discoverBuildFixtures } from "../../../__tests__/helpers/discoverBuildFixtures";

// getSeedArtists returns [] so only the popular fallback runs.
jest.mock("../../discovery", () => ({
    discoveryBatchLogger: { info: jest.fn(), error: jest.fn() },
    discoverySeeding: { getSeedArtists: jest.fn().mockResolvedValue([]) },
    discoveryAlbumLifecycle: { processBeforeGeneration: jest.fn() },
}));

// cleanupFailedArtists calls lidarrService.getDiscoveryArtists after the catch
// and cleanupOrphanedLidarrQueue calls getSystemSettings. Both run on every
// buildFinalPlaylist exit path, so stub them to no-op/empty.
jest.mock("../../lidarr", () => ({
    lidarrService: {
        getDiscoveryArtists: jest.fn().mockResolvedValue([]),
    },
}));
jest.mock("../../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue(null),
}));

// eventBus.emit fires after the catch; stubbed to leave the real channel alone.
jest.mock("../../eventBus", () => ({
    eventBus: { emit: jest.fn() },
}));

// Import-time-only heavy deps (BullMQ queues instantiate at module load,
// the musicbrainz/acquisition chain pulls network clients). Stub so the module
// graph loads without opening Redis/HTTP handles.
jest.mock("../../../workers/queues", () => ({
    scanQueue: { add: jest.fn() },
    discoverQueue: { add: jest.fn() },
}));
jest.mock("../../musicbrainz", () => ({ musicBrainzService: {} }));
jest.mock("../../acquisitionService", () => ({ acquisitionService: {} }));
jest.mock("../../discoveryLogger", () => ({
    discoveryLogger: { info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../artistCountsService", () => ({
    updateArtistCounts: jest.fn(),
}));

const P = "zz-jobMatch-";
const BATCH = `${P}batch`;
const fx = discoverBuildFixtures(P);
const SCANNED_MBID = "temp-1793617784650-0.26";

/**
 * A scanning batch with one completed job named as Lidarr named it, and one scanned song named as the files are.
 * By default the job's release-group id is not the scanned album's, so the song is found by name.
 */
async function arrange(
    job: { artistName: string; albumTitle: string },
    scanned: { artistName: string; albumTitle: string },
    albumMbid = "3372b3ce-c462-4937-9da3-011e93921b6b",
) {
    await fx.seedScanningBatch(BATCH, [
        { ...job, albumMbid, lidarrAlbumId: 36401, similarity: 0.7, tier: "medium" },
    ]);
    await fx.seedDiscoverSong(BATCH, { ...scanned, rgMbid: SCANNED_MBID });
}

/** The Lidarr id the stored Discover suggestion for the scanned album recorded. */
const recordedSuggestion = () =>
    prisma.discoveryAlbum.findFirst({ where: { userId: fx.userId, rgMbid: SCANNED_MBID } });

describe("buildFinalPlaylist links a Discover album to its download job", () => {
    beforeAll(fx.wipe);
    afterAll(fx.wipe);
    beforeEach(fx.wipe);

    it.each([
        ["a curly apostrophe", { artistName: "Ed O’Brien", albumTitle: "Blue Morpho" }, { artistName: "Ed O'Brien", albumTitle: "Blue Morpho" }],
        ["accents", { artistName: "Orelsan", albumTitle: "La fête est finie" }, { artistName: "Orelsan", albumTitle: "La Fete Est Finie" }],
        ["a Unicode hyphen", { artistName: "Angèle", albumTitle: "Nonante‐cinq" }, { artistName: "Angèle", albumTitle: "Nonante-Cinq" }],
        ["an ellipsis character", { artistName: "Queens of the Stone Age", albumTitle: "In Times New Roman…" }, { artistName: "Queens Of The Stone Age", albumTitle: "In Times New Roman..." }],
    ])("records the job's Lidarr id when the names differ only by %s", async (_how, job, scanned) => {
        await arrange(job, scanned);

        await discoverWeeklyService.buildFinalPlaylist(BATCH);

        const suggestion = await recordedSuggestion();
        expect(suggestion?.lidarrAlbumId).toBe(36401);
        expect(suggestion?.tier).toBe("medium");
    });

    it("records no Lidarr id for an album no job names", async () => {
        // The song is found by its release-group id, but no job carries its name.
        await arrange({ artistName: "Orelsan", albumTitle: "Civilisation" }, { artistName: "Orelsan", albumTitle: "La Fete Est Finie" }, SCANNED_MBID);

        await discoverWeeklyService.buildFinalPlaylist(BATCH);

        const suggestion = await recordedSuggestion();
        expect(suggestion).not.toBeNull();
        expect(suggestion?.lidarrAlbumId).toBeNull();
    });

    describe("with the artist-identity rule (sameArtist)", () => {
        const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
        const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";
        const PLACEHOLDER = "temp-1793617784650-0.5";
        const names = { artistName: "Ed O'Brien", albumTitle: "Blue Morpho" };
        const scanned = { ...names, rgMbid: SCANNED_MBID, artistMbid: ARTIST };

        it("does not take a namesake's job for this album, even when it comes first", async () => {
            await fx.seedScanningBatch(BATCH, [
                { ...names, albumMbid: "11111111-aaaa-4aaa-8aaa-111111111111", artistMbid: NAMESAKE, lidarrAlbumId: 111, tier: "wild" },
                { ...names, albumMbid: "22222222-aaaa-4aaa-8aaa-222222222222", artistMbid: ARTIST, lidarrAlbumId: 222, tier: "core" },
            ]);
            await fx.seedDiscoverSong(BATCH, scanned);

            await discoverWeeklyService.buildFinalPlaylist(BATCH);

            const suggestion = await recordedSuggestion();
            expect(suggestion?.lidarrAlbumId).toBe(222);
            expect(suggestion?.tier).toBe("core");
        });

        it("records no job for an album only a namesake's job names", async () => {
            // Found by its release-group id, so the build goes on; no job is this artist's.
            await fx.seedScanningBatch(BATCH, [{ ...names, albumMbid: SCANNED_MBID, artistMbid: NAMESAKE, lidarrAlbumId: 111, tier: "wild" }]);
            await fx.seedDiscoverSong(BATCH, scanned);

            await discoverWeeklyService.buildFinalPlaylist(BATCH);

            const suggestion = await recordedSuggestion();
            expect(suggestion).not.toBeNull();
            expect(suggestion?.lidarrAlbumId).toBeNull();
        });

        it.each([
            ["the same id", ARTIST],
            ["no id", null],
            ["a temp- placeholder", PLACEHOLDER],
        ])("takes the job that has %s", async (_how, artistMbid) => {
            await fx.seedScanningBatch(BATCH, [{ ...names, albumMbid: SCANNED_MBID, artistMbid, lidarrAlbumId: 222, tier: "core" }]);
            await fx.seedDiscoverSong(BATCH, scanned);

            await discoverWeeklyService.buildFinalPlaylist(BATCH);

            expect((await recordedSuggestion())?.lidarrAlbumId).toBe(222);
        });

        it("takes a job by name when the scanned artist has no real id", async () => {
            await fx.seedScanningBatch(BATCH, [{ ...names, albumMbid: SCANNED_MBID, artistMbid: NAMESAKE, lidarrAlbumId: 222, tier: "core" }]);
            await fx.seedDiscoverSong(BATCH, { ...scanned, artistMbid: null });

            await discoverWeeklyService.buildFinalPlaylist(BATCH);

            expect((await recordedSuggestion())?.lidarrAlbumId).toBe(222);
        });
    });
});
