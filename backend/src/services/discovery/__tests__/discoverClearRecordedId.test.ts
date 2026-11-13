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
import { clearSuggestion } from "../discoverClearing";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const MARK = "zz-clear-recorded-id";
const USER = `${MARK}-user`;
const PLACEHOLDER = "temp-1793617784650-0.26278128602101924";
const MBID = "3372b3ce-c462-4937-9da3-011e93921b6b";

async function cleanup() {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: MARK } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

/** The prod case: files scanned as "Ed O'Brien - Blue Morpho" under a placeholder id, the suggestion without a Lidarr id. */
async function stuckSuggestion() {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user" } });
    const artist = await prisma.artist.create({ data: { name: "Ed O'Brien", identityKey: `${MARK}-artist` } });
    const album = await prisma.album.create({
        data: { rgMbid: PLACEHOLDER, identityKey: `${MARK}-album`, primaryType: "Album", title: "Blue Morpho", artistId: artist.id, location: "DISCOVER" },
    });
    await prisma.track.create({
        data: { title: `${MARK} song`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${MARK}/01.flac`, fileModified: new Date(), fileSize: 1000 },
    });
    return prisma.discoveryAlbum.create({
        data: { userId: USER, rgMbid: PLACEHOLDER, artistName: "Ed O'Brien", albumTitle: "Blue Morpho", weekStartDate: new Date("2026-11-02"), status: "ACTIVE" },
    });
}

/** A completed download of the album as Lidarr named it, by Discover (in a batch) or by the listener. */
async function job(lidarrAlbumId: number, by: "discover" | "listener") {
    const batch = by === "discover"
        ? await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date("2026-11-02"), targetSongCount: 10, status: "completed" } })
        : null;
    await prisma.downloadJob.create({
        data: {
            userId: USER, subject: "Ed O’Brien - Blue Morpho", type: "album", status: "completed", targetMbid: MBID, lidarrAlbumId,
            discoveryBatchId: batch?.id ?? null,
            metadata: { currentSource: "lidarr", artistName: "Ed O’Brien", albumTitle: "Blue Morpho", albumMbid: MBID, ...(by === "discover" ? { downloadType: "discovery" } : {}) },
        },
    });
}

const suggestionRow = (row: { id: string }) => ({ id: row.id, rgMbid: PLACEHOLDER, artistName: "Ed O'Brien", albumTitle: "Blue Morpho", lidarrAlbumId: null });

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
});
