/**
 * Every Discover matcher in discoverClearing uses the one artist-identity rule (discoverEvidence's sameArtist): the same
 * names under another artist's MusicBrainz id are a namesake and never match; a missing or `temp-` id still matches by
 * name. Real database; Lidarr's removal is stubbed, as lidarrRemoval's own tests cover it.
 */

jest.mock("../lidarrRemoval", () => ({
    removeDiscoveryAlbum: jest.fn().mockResolvedValue({ removed: true, reason: null }),
}));
jest.mock("../../lidarr", () => ({
    lidarrService: { isEnabled: jest.fn().mockResolvedValue(true), findAlbumByForeignId: jest.fn().mockResolvedValue(null) },
}));

import { prisma } from "../../../utils/db";
import { removeDiscoveryAlbum } from "../lidarrRemoval";
import { clearOrphanedDiscoverAlbums, clearSuggestion, clearUnsuggestedDownloads, findScannedAlbum } from "../discoverClearing";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import * as downloadJobs from "../../downloads/jobs";

const MARK = "zz-clear-identity";
const USER = `${MARK}-user`;
const OTHER_USER = `${MARK}-other`;
/** The key the scanner stores for "Ed O'Brien", which findScannedAlbum looks the artist up by. */
const ARTIST_KEY = "edobrien";
const RG = "temp-1793617784650-0.26278128602101924";
const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";
const PLACEHOLDER = "temp-1793617784650-0.5";
/** Ids that make an artist known by name only. */
const NO_REAL_ID: [string | null][] = [[null], [PLACEHOLDER]];
/** The same artist's id, or none the rule can read. */
const SAME_OR_NONE: [string | null][] = [[ARTIST], ...NO_REAL_ID];

async function cleanup() {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
    await prisma.downloadJob.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: { in: [USER, OTHER_USER] } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { identityKey: ARTIST_KEY } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER_USER] } } });
}

/** A scanned album "Ed O'Brien - Blue Morpho" whose artist row carries `artistMbid`. */
async function scannedAlbum(artistMbid: string | null, location: "DISCOVER" | "LIBRARY" = "DISCOVER") {
    const artist = await prisma.artist.create({ data: { name: "Ed O'Brien", identityKey: ARTIST_KEY, mbid: artistMbid } });
    const album = await prisma.album.create({
        data: { rgMbid: RG, identityKey: `${MARK}-album`, primaryType: "Album", title: "Blue Morpho", artistId: artist.id, location },
    });
    await prisma.track.create({
        data: { title: `${MARK} song`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${MARK}/01.flac`, fileModified: new Date(), fileSize: 1000 },
    });
    return album;
}

async function users() {
    for (const id of [USER, OTHER_USER]) {
        await prisma.user.create({ data: { id, username: id, passwordHash: "x", role: "user" } });
    }
}

/** A Discover suggestion for the album, in the given status, under the given artist id. */
const suggestion = (
    artistMbid: string | null,
    extra: { userId?: string; status?: "ACTIVE" | "DELETED" | "LIKED"; rgMbid?: string; albumTitle?: string } = {},
) =>
    prisma.discoveryAlbum.create({
        data: {
            userId: extra.userId ?? USER,
            rgMbid: extra.rgMbid ?? RG,
            artistName: "Ed O'Brien",
            artistMbid,
            albumTitle: extra.albumTitle ?? "Blue Morpho",
            weekStartDate: new Date("2026-11-02"),
            status: extra.status ?? "ACTIVE",
        },
    });

/** A finished Discover download of the album, from Soulseek (or Lidarr, with an album id), naming the artist under `artistMbid`. */
async function discoverJob(
    artistMbid: string | null,
    extra: { userId?: string; source?: "soulseek" | "lidarr"; lidarrAlbumId?: number; targetMbid?: string | null; batchStatus?: string } = {},
) {
    const userId = extra.userId ?? USER;
    const batch = await prisma.discoveryBatch.create({
        data: { userId, weekStart: new Date("2026-11-02"), targetSongCount: 10, status: extra.batchStatus ?? "completed" },
    });
    return prisma.downloadJob.create({
        data: {
            userId,
            subject: "Ed O’Brien - Blue Morpho",
            type: "album",
            status: "completed",
            artistMbid,
            targetMbid: extra.targetMbid ?? null,
            lidarrAlbumId: extra.lidarrAlbumId ?? null,
            discoveryBatchId: batch.id,
            metadata: { currentSource: extra.source ?? "soulseek", artistName: "Ed O’Brien", albumTitle: "Blue Morpho", downloadType: "discovery" },
        },
    });
}

const ref = (artistMbid: string | null) => ({ rgMbid: RG, artistName: "Ed O'Brien", albumTitle: "Blue Morpho", artistMbid });
const row = (s: { id: string; artistMbid: string | null }) => ({ ...ref(s.artistMbid), id: s.id, lidarrAlbumId: null });

beforeEach(async () => {
    jest.clearAllMocks();
    await cleanup();
    await users();
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("findScannedAlbum", () => {
    const byName = (artistMbid: string | null) => findScannedAlbum({ ...ref(artistMbid), rgMbid: "temp-another-id" }, "DISCOVER");

    it("never finds an album by name under a namesake's MusicBrainz id", async () => {
        await scannedAlbum(NAMESAKE);
        expect(await byName(ARTIST)).toBeNull();
    });

    it("finds it by name under the same MusicBrainz id", async () => {
        const album = await scannedAlbum(ARTIST);
        expect((await byName(ARTIST))?.id).toBe(album.id);
    });

    it.each(NO_REAL_ID)("finds it by name when the album's artist id is %s", async (id) => {
        const album = await scannedAlbum(id);
        expect((await byName(ARTIST))?.id).toBe(album.id);
    });

    it.each(NO_REAL_ID)("finds it by name when the record's artist id is %s", async (id) => {
        const album = await scannedAlbum(NAMESAKE);
        expect((await byName(id))?.id).toBe(album.id);
    });
});

describe("forgetDiscoverDownloads (clearing an album that is the library's)", () => {
    it("keeps a namesake's Discover download record, which names the album only by artist and title", async () => {
        await scannedAlbum(ARTIST, "LIBRARY");
        const s = await suggestion(ARTIST);
        const namesake = await discoverJob(NAMESAKE);

        expect(await clearSuggestion(row(s))).toEqual({ outcome: "cleared" });
        expect(await prisma.downloadJob.findUnique({ where: { id: namesake.id } })).not.toBeNull();
    });

    it.each(SAME_OR_NONE)("forgets a Discover download record whose artist id is %s", async (id) => {
        await scannedAlbum(ARTIST, "LIBRARY");
        const s = await suggestion(ARTIST);
        const own = await discoverJob(id);

        expect(await clearSuggestion(row(s))).toEqual({ outcome: "cleared" });
        // A batch job is deleted in its batch lane, after the checks queued there.
        await downloadJobs.whenIdle();
        expect(await prisma.downloadJob.findUnique({ where: { id: own.id } })).toBeNull();
    });
});

describe("isKnownSoulseekAlbum (clearing a Discover album Lidarr does not hold)", () => {
    it("does not take a namesake's Soulseek download as this album's source", async () => {
        await scannedAlbum(ARTIST);
        const s = await suggestion(ARTIST);
        await discoverJob(NAMESAKE);

        const result = await clearSuggestion(row(s));
        expect(result.outcome).toBe("kept");
        expect(await prisma.album.findFirst({ where: { identityKey: `${MARK}-album` } })).not.toBeNull();
    });

    it("does not let a namesake's Lidarr download rule out Soulseek as the source", async () => {
        await scannedAlbum(ARTIST);
        const s = await suggestion(ARTIST);
        await discoverJob(ARTIST);
        await discoverJob(NAMESAKE, { source: "lidarr" });

        expect(await clearSuggestion(row(s))).toEqual({ outcome: "cleared" });
    });

    it.each(SAME_OR_NONE)("takes a Soulseek download whose artist id is %s", async (id) => {
        await scannedAlbum(ARTIST);
        const s = await suggestion(ARTIST);
        await discoverJob(id);

        expect(await clearSuggestion(row(s))).toEqual({ outcome: "cleared" });
        expect(await prisma.album.findFirst({ where: { identityKey: `${MARK}-album` } })).toBeNull();
    });
});

describe("clearUnsuggestedDownloads", () => {
    /** The Lidarr copy of a finished Discover download of the album under `artistMbid`. */
    const lidarrCopy = (artistMbid: string | null) =>
        discoverJob(artistMbid, { source: "lidarr", lidarrAlbumId: 5150, targetMbid: "temp-lidarr-copy" });

    it("is not stopped by a namesake's suggestion of the same names (hasSuggestion)", async () => {
        await lidarrCopy(ARTIST);
        await suggestion(NAMESAKE, { rgMbid: "temp-namesake" });

        expect(await clearUnsuggestedDownloads(USER)).toEqual([]);
        expect(removeDiscoveryAlbum).toHaveBeenCalledTimes(1);
    });

    it.each(SAME_OR_NONE)("is stopped by this listener's suggestion of the same names under artist id %s", async (id) => {
        await lidarrCopy(ARTIST);
        await suggestion(id, { rgMbid: "temp-another-suggestion" });

        await clearUnsuggestedDownloads(USER);
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });

    it("is not stopped by a namesake's liked album (likedArtist)", async () => {
        await lidarrCopy(ARTIST);
        await suggestion(NAMESAKE, { status: "LIKED", rgMbid: "temp-liked", albumTitle: "Another Album" });

        await clearUnsuggestedDownloads(USER);
        expect(removeDiscoveryAlbum).toHaveBeenCalledTimes(1);
    });

    it.each(SAME_OR_NONE)("is stopped by a liked album by the same artist under id %s", async (id) => {
        await lidarrCopy(ARTIST);
        await suggestion(id, { status: "LIKED", rgMbid: "temp-liked", albumTitle: "Another Album" });

        await clearUnsuggestedDownloads(USER);
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });

    it("is stopped by a liked album of the same MusicBrainz id even when the names are spelled differently", async () => {
        await lidarrCopy(ARTIST);
        await prisma.discoveryAlbum.create({
            data: {
                userId: USER,
                rgMbid: "temp-liked",
                artistName: "Edward O'Brien",
                artistMbid: ARTIST,
                albumTitle: "Another Album",
                weekStartDate: new Date("2026-11-02"),
                status: "LIKED",
            },
        });

        await clearUnsuggestedDownloads(USER);
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });
});

describe("clearOrphanedDiscoverAlbums", () => {
    it("returns an album to the library when only a namesake's suggestion names it (discoverRecordNames)", async () => {
        await scannedAlbum(ARTIST);
        await suggestion(NAMESAKE, { status: "DELETED", rgMbid: "temp-namesake" });

        const result = await clearOrphanedDiscoverAlbums();
        expect(result.returned).toBe(1);
        expect(result.failures).toEqual([]);
    });

    it("returns an album to the library when only a namesake's Discover download names it", async () => {
        await scannedAlbum(ARTIST);
        await discoverJob(NAMESAKE);

        expect((await clearOrphanedDiscoverAlbums()).returned).toBe(1);
    });

    it.each(SAME_OR_NONE)("keeps trying an album a suggestion under artist id %s names", async (id) => {
        await scannedAlbum(ARTIST);
        await suggestion(id, { status: "DELETED", rgMbid: "temp-another-suggestion" });

        const result = await clearOrphanedDiscoverAlbums();
        expect(result.returned).toBe(0);
        expect(result.failures).toHaveLength(1);
    });

    it.each(SAME_OR_NONE)("keeps trying an album a Discover download under artist id %s names", async (id) => {
        await scannedAlbum(ARTIST);
        await discoverJob(id, { source: "lidarr" });

        const result = await clearOrphanedDiscoverAlbums();
        expect(result.returned).toBe(0);
        expect(result.failures).toHaveLength(1);
    });

    it("reports a failed album to the listeners whose records name it, not a namesake's (listenersNaming)", async () => {
        await scannedAlbum(ARTIST);
        await discoverJob(ARTIST, { userId: USER, source: "lidarr" });
        await suggestion(NAMESAKE, { userId: OTHER_USER, status: "DELETED", rgMbid: "temp-namesake" });
        await discoverJob(NAMESAKE, { userId: OTHER_USER, source: "lidarr" });

        const { failures } = await clearOrphanedDiscoverAlbums();
        expect(failures).toHaveLength(1);
        expect(failures[0].userIds).toEqual([USER]);
    });

    it.each(NO_REAL_ID)("reports a failed album to a listener whose suggestion has artist id %s", async (id) => {
        await scannedAlbum(ARTIST);
        await discoverJob(ARTIST, { userId: USER, source: "lidarr" });
        await suggestion(id, { userId: OTHER_USER, status: "DELETED", rgMbid: "temp-by-name" });

        const { failures } = await clearOrphanedDiscoverAlbums();
        expect([...failures[0].userIds].sort()).toEqual([OTHER_USER, USER].sort());
    });
});

describe("clearOrphanedDiscoverAlbums' two coverage checks", () => {
    it("is not covered by a namesake's current suggestion of the same names (discoverAlbumIsCovered)", async () => {
        await scannedAlbum(ARTIST);
        await suggestion(NAMESAKE, { rgMbid: "temp-namesake" });

        const result = await clearOrphanedDiscoverAlbums();
        expect(result.returned).toBe(1);
        expect(await prisma.album.findFirst({ where: { identityKey: `${MARK}-album`, location: "LIBRARY" } })).not.toBeNull();
    });

    it.each(SAME_OR_NONE)("is covered by a current suggestion of the same names under artist id %s", async (id) => {
        await scannedAlbum(ARTIST);
        await suggestion(id, { rgMbid: "temp-another-suggestion" });

        expect(await clearOrphanedDiscoverAlbums()).toEqual({ cleared: 0, returned: 0, failures: [] });
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });

    it.each(NO_REAL_ID)("is covered by a suggestion of the same names when the album's artist id is %s", async (id) => {
        await scannedAlbum(id);
        await suggestion(NAMESAKE, { rgMbid: "temp-another-suggestion" });

        expect(await clearOrphanedDiscoverAlbums()).toEqual({ cleared: 0, returned: 0, failures: [] });
    });

    it("is not held back by a namesake's download in a running batch (albumsInRunningBatches)", async () => {
        await scannedAlbum(ARTIST);
        await discoverJob(NAMESAKE, { batchStatus: "downloading" });

        expect((await clearOrphanedDiscoverAlbums()).returned).toBe(1);
    });

    it.each(NO_REAL_ID)("is held back by a namesake-id download in a running batch when the album's artist id is %s", async (id) => {
        await scannedAlbum(id);
        await discoverJob(NAMESAKE, { batchStatus: "downloading" });

        expect(await clearOrphanedDiscoverAlbums()).toEqual({ cleared: 0, returned: 0, failures: [] });
    });

    it.each(SAME_OR_NONE)("is held back by a download in a running batch under artist id %s", async (id) => {
        await scannedAlbum(ARTIST);
        await discoverJob(id, { batchStatus: "downloading" });

        expect(await clearOrphanedDiscoverAlbums()).toEqual({ cleared: 0, returned: 0, failures: [] });
        expect(removeDiscoveryAlbum).not.toHaveBeenCalled();
    });
});
