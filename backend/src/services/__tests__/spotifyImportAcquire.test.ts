/**
 * Importing a playlist downloads in three places, and each is acquisition (#238): quick import picks every missing
 * album, a queued import downloads the albums chosen when it was queued, and building the playlist retries each
 * unmatched song through Soulseek. A member may do none of them while member downloads are off; the playlist is
 * still made. Real database and Redis; the playlist fetch, Soulseek and Deezer's preview lookup are stubbed.
 */
jest.mock("../soulseek", () => ({
    soulseekService: { isConnected: jest.fn(), searchTrack: jest.fn(), downloadBestMatch: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { deezerService } from "../deezer";
import { soulseekService } from "../soulseek";
import { eventBus, type SSEEvent } from "../eventBus";
import { spotifyImportService } from "../spotifyImport";

const MEMBER = "zz-import-member";
const ADMIN = "zz-import-admin";
const URL = "https://www.deezer.com/playlist/90210";
const preview = {
    playlist: { id: "90210", name: "Road trip" },
    summary: { total: 2, inLibrary: 0, downloadable: 2 },
    albumsToDownload: [{ albumMbid: "mbid-a", spotifyAlbumId: "sp-a", tracksNeeded: [{}] }],
};
const UNMATCHED = {
    artist: "Nobody Here",
    title: "A Song No Library Has",
    album: "Unknown Album",
    albumMbid: null,
    artistMbid: null,
    preMatchedTrackId: null,
    isrc: null,
};
const soulseek = soulseekService as unknown as Record<"isConnected" | "searchTrack" | "downloadBestMatch", jest.Mock>;
const service = spotifyImportService as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

/** The albums quick import hands to the import that follows it. */
async function albumsQuickImportHandsOn(userId: string): Promise<string[]> {
    jest.spyOn(deezerService, "getPlaylist").mockResolvedValue({ id: "90210" } as never);
    // quickImport asks Deezer for the playlist's name; this test is about who may download, so it gets none.
    jest.spyOn(deezerService, "getPlaylistName").mockResolvedValue(null);
    jest.spyOn(spotifyImportService, "generatePreviewFromDeezer").mockResolvedValue(preview as never);
    jest.spyOn(spotifyImportService as never, "buildPendingTracks").mockReturnValue([] as never);
    const processImport = jest.spyOn(spotifyImportService as never, "processImport").mockResolvedValue(undefined as never);
    const { jobId } = await spotifyImportService.quickImport(URL, userId);
    await spotifyImportService.processQuickImportFromQueue(jobId, URL);
    expect(processImport).toHaveBeenCalledTimes(1);
    return (processImport.mock.calls[0] as unknown[])[1] as string[];
}

/** The albums a queued import downloads, for an import queued with one album chosen. */
async function albumsQueuedImportDownloads(userId: string): Promise<string[]> {
    const id = `zz-queued-${userId}`;
    await prisma.spotifyImportJob.create({
        data: { id, userId, spotifyPlaylistId: "90210", playlistName: "Road trip", status: "pending", albumsTotal: 1, tracksTotal: 1, pendingTracks: [] },
    });
    await redisClient.setex(`import:preview:${id}`, 60, JSON.stringify(preview));
    const processImport = jest.spyOn(spotifyImportService as never, "processImport").mockResolvedValue(undefined as never);
    await spotifyImportService.processImportFromQueue(id, ["mbid-a"]);
    expect(processImport).toHaveBeenCalledTimes(1);
    return (processImport.mock.calls[0] as unknown[])[1] as string[];
}

/** Runs an import with no albums chosen through the real playlist build, and waits for its retry of the unmatched song. */
async function importWithoutAlbums(userId: string): Promise<void> {
    jest.spyOn(deezerService, "getTrackPreview").mockResolvedValue(null);
    const retry = jest.spyOn(spotifyImportService as never, "autoRetryPendingTracks");
    const now = new Date();
    await service.processImport(
        {
            id: `zz-import-${userId}`, userId, spotifyPlaylistId: "90210", playlistName: `zz road trip ${userId}`, status: "pending",
            progress: 0, albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksTotal: 1, tracksDownloadable: 0,
            createdPlaylistId: null, error: null, sourceUrl: null, createdAt: now, updatedAt: now, pendingTracks: [UNMATCHED],
        },
        [],
        preview,
    );
    expect(retry).toHaveBeenCalledTimes(1);
    // The retry runs after the playlist is saved, without being awaited; wait for it here.
    await retry.mock.results[0].value;
}

/** The test users and, by cascade, their imports and playlists. */
const removeUsers = () => prisma.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });

beforeAll(async () => {
    await waitForRedisReady();
    await removeUsers();
    // A rerun within the minute finds the previous run's previews; they expire on their own otherwise.
    await redisClient.del(`import:preview:zz-queued-${MEMBER}`, `import:preview:zz-queued-${ADMIN}`);
    for (const [id, role] of [[MEMBER, "user"], [ADMIN, "admin"]] as const) {
        await prisma.user.create({ data: { id, username: id, passwordHash: "x", role } });
    }
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", allowMemberAcquire: false, musicPath: "/music" },
        update: { allowMemberAcquire: false, musicPath: "/music" },
    });
    invalidateSystemSettingsCache();
});

beforeEach(() => {
    soulseek.isConnected.mockReset().mockReturnValue(true);
    soulseek.searchTrack.mockReset().mockResolvedValue({ found: true, allMatches: [{ file: "a.flac" }] });
    soulseek.downloadBestMatch.mockReset().mockResolvedValue({ success: false, error: "stubbed" });
});

afterEach(() => jest.restoreAllMocks());

// Redis is closed by the test setup before this runs; the previews expire within the minute.
afterAll(removeUsers);

describe("quick import", () => {
    it("hands no albums on for a member while member downloads are off", async () => {
        expect(await albumsQuickImportHandsOn(MEMBER)).toEqual([]);
    });

    it("hands every missing album on for an admin", async () => {
        expect(await albumsQuickImportHandsOn(ADMIN)).toEqual(["mbid-a"]);
    });
});

describe("a queued import", () => {
    it("drops the chosen albums for a member whose downloads were switched off after queueing", async () => {
        expect(await albumsQueuedImportDownloads(MEMBER)).toEqual([]);
    });

    it("downloads them for an admin", async () => {
        expect(await albumsQueuedImportDownloads(ADMIN)).toEqual(["mbid-a"]);
    });
});

describe("an import whose user is gone", () => {
    it("may start no downloads", async () => {
        expect(await service.importerMayAcquire("zz-import-deleted-user")).toBe(false);
    });
});

describe("an import's unmatched songs", () => {
    it("are never searched or downloaded for a member, and stay on the playlist as pending", async () => {
        const heard: SSEEvent[] = [];
        const stop = eventBus.subscribe(MEMBER, { send: (event) => (heard.push(event), true) });
        await importWithoutAlbums(MEMBER).finally(stop);

        expect(soulseek.searchTrack).not.toHaveBeenCalled();
        expect(soulseek.downloadBestMatch).not.toHaveBeenCalled();
        const playlist = await prisma.playlist.findFirst({ where: { userId: MEMBER }, select: { id: true, pendingTracks: { select: { spotifyTitle: true } } } });
        expect(playlist?.pendingTracks.map((t) => t.spotifyTitle)).toEqual([UNMATCHED.title]);
        // The new playlist reaches the importer's open devices.
        expect(heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload)).toEqual([{ playlistId: playlist?.id, deleted: false }]);
    });

    it("are searched for and downloaded for an admin", async () => {
        await importWithoutAlbums(ADMIN);

        expect(soulseek.searchTrack).toHaveBeenCalledWith(UNMATCHED.artist, UNMATCHED.title, undefined);
        expect(soulseek.downloadBestMatch).toHaveBeenCalledTimes(1);
    });
});
