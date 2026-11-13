/**
 * A Discover suggestion that never got its Lidarr album id (the weekly run missed its download job over typography)
 * is cleared by the id Discover's own download job recorded, matched by artist and title as sameName compares them. A
 * listener's own download of the same album is never Discover's record. Real database; Lidarr's removal is stubbed,
 * as lidarrRemoval's own tests cover it.
 */

jest.mock("../lidarrRemoval", () => ({
    removeDiscoveryAlbum: jest.fn().mockResolvedValue({ removed: true, reason: null }),
}));
jest.mock("../../lidarr", () => ({
    lidarrService: { isEnabled: jest.fn().mockResolvedValue(true), findAlbumByForeignId: jest.fn().mockResolvedValue(null) },
}));

import { prisma } from "../../../utils/db";
import { removeDiscoveryAlbum } from "../lidarrRemoval";
import { clearOrphanedDiscoverAlbums, clearSuggestion } from "../discoverClearing";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const MARK = "zz-clear-recorded-id";
const USER = `${MARK}-user`;
const PLACEHOLDER = "temp-1793617784650-0.26278128602101924";
const MBID = "3372b3ce-c462-4937-9da3-011e93921b6b";
const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";

async function cleanup() {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: MARK } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

/** The prod case: files scanned as "Ed O'Brien - Blue Morpho" under a placeholder id. */
async function stuckAlbum(artistMbid: string | null = null) {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user" } });
    const artist = await prisma.artist.create({ data: { name: "Ed O'Brien", identityKey: `${MARK}-artist`, mbid: artistMbid } });
    const album = await prisma.album.create({
        data: { rgMbid: PLACEHOLDER, identityKey: `${MARK}-album`, primaryType: "Album", title: "Blue Morpho", artistId: artist.id, location: "DISCOVER" },
    });
    await prisma.track.create({
        data: { title: `${MARK} song`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${MARK}/01.flac`, fileModified: new Date(), fileSize: 1000 },
    });
    return album;
}

/** The suggestion for that album, without a Lidarr id (the weekly run missed its download job over typography). */
async function stuckSuggestion(artistMbid: string | null = null) {
    await stuckAlbum(artistMbid);
    return prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: PLACEHOLDER, artistName: "Ed O'Brien", artistMbid, albumTitle: "Blue Morpho", weekStartDate: new Date("2026-11-02"), status: "ACTIVE" },
    });
}

/** A completed download of the album as Lidarr named it, by Discover (in a batch) or by the listener. */
async function job(lidarrAlbumId: number, by: "discover" | "listener", artistMbid: string | null = null, targetMbid: string = MBID) {
    const batch = by === "discover"
        ? await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date("2026-11-02"), targetSongCount: 10, status: "completed" } })
        : null;
    await prisma.downloadJob.create({
        data: {
            userId: USER, subject: "Ed O’Brien - Blue Morpho", type: "album", status: "completed", targetMbid, lidarrAlbumId, artistMbid,
            discoveryBatchId: batch?.id ?? null,
            metadata: { currentSource: "lidarr", artistName: "Ed O’Brien", albumTitle: "Blue Morpho", albumMbid: MBID, ...(by === "discover" ? { downloadType: "discovery" } : {}) },
        },
    });
}

const suggestionRow = (row: { id: string; artistMbid: string | null }) => ({
    id: row.id, rgMbid: PLACEHOLDER, artistMbid: row.artistMbid, artistName: "Ed O'Brien", albumTitle: "Blue Morpho", lidarrAlbumId: null,
});

beforeEach(async () => {
    jest.clearAllMocks();
    await cleanup();
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("clearing a suggestion with no Lidarr id", () => {
    it("asks Lidarr to delete the album by the id Discover's download job recorded under Lidarr's spelling", async () => {
        const row = await stuckSuggestion();
        await job(36401, "discover");

        expect(await clearSuggestion(suggestionRow(row))).toEqual({ outcome: "cleared" });
        expect(removeDiscoveryAlbum).toHaveBeenCalledWith(36401, PLACEHOLDER, expect.anything());
    });

    it("never takes the Lidarr id from a listener's own download", async () => {
        const row = await stuckSuggestion();
        await job(99999, "listener");

        const result = await clearSuggestion(suggestionRow(row));
        expect(result.outcome).toBe("kept");
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });

    it("takes the id of a job that names the same artist by MusicBrainz id", async () => {
        const row = await stuckSuggestion(ARTIST);
        await job(36402, "discover", ARTIST);

        expect(await clearSuggestion(suggestionRow(row))).toEqual({ outcome: "cleared" });
        expect(removeDiscoveryAlbum).toHaveBeenCalledWith(36402, PLACEHOLDER, expect.anything());
    });

    it("never takes the id of a namesake: the same names under another artist's MusicBrainz id", async () => {
        const row = await stuckSuggestion(ARTIST);
        await job(77777, "discover", NAMESAKE);

        const result = await clearSuggestion(suggestionRow(row));
        expect(result.outcome).toBe("kept");
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });

    it.each([[null], ["temp-1793617784650-0.5"]])("matches a job whose artist id is %s by name", async (jobArtistMbid) => {
        const row = await stuckSuggestion(ARTIST);
        await job(36403, "discover", jobArtistMbid);

        expect(await clearSuggestion(suggestionRow(row))).toEqual({ outcome: "cleared" });
        expect(removeDiscoveryAlbum).toHaveBeenCalledWith(36403, PLACEHOLDER, expect.anything());
    });

    it("matches a job by name when the suggestion's own artist id is a placeholder", async () => {
        const row = await stuckSuggestion("temp-1793617784650-0.7");
        await job(36404, "discover", NAMESAKE);

        expect(await clearSuggestion(suggestionRow(row))).toEqual({ outcome: "cleared" });
        expect(removeDiscoveryAlbum).toHaveBeenCalledWith(36404, PLACEHOLDER, expect.anything());
    });

    it("takes the id of the job that names the album's release group, whatever artist it records", async () => {
        const row = await stuckSuggestion(ARTIST);
        await prisma.discoveryAlbum.update({ where: { id: row.id }, data: { artistName: "Someone Else", albumTitle: "Other Title" } });
        await job(36405, "discover", NAMESAKE, PLACEHOLDER);

        const result = await clearSuggestion({ ...suggestionRow(row), artistName: "Someone Else", albumTitle: "Other Title" });
        expect(result).toEqual({ outcome: "cleared" });
        expect(removeDiscoveryAlbum).toHaveBeenCalledWith(36405, PLACEHOLDER, expect.anything());
    });
});

describe("sweeping a Discover album no suggestion covers", () => {
    it("never takes the Lidarr id of a namesake's job: the same names under another artist's MusicBrainz id", async () => {
        await stuckAlbum(ARTIST);
        await job(88888, "discover", NAMESAKE);

        await clearOrphanedDiscoverAlbums();
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });

    it("takes the Lidarr id of a job that names the same artist by MusicBrainz id", async () => {
        await stuckAlbum(ARTIST);
        await job(36406, "discover", ARTIST);

        const { cleared } = await clearOrphanedDiscoverAlbums();
        expect(cleared).toBe(1);
        expect(removeDiscoveryAlbum).toHaveBeenCalledWith(36406, PLACEHOLDER, expect.anything());
    });
});
