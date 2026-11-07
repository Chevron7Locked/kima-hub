/**
 * A pasted music link reaches the importer for its own site, through the real routes and the real import service
 * (real Postgres and Redis). Only the calls that leave for the outside sites are stood in for: the Deezer and Spotify
 * clients, yt-dlp, song.link, and sign-in.
 */
jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "zz-dispatch-usr", role: "admin" };
        next();
    },
}));
const mockExtractPlaylist = jest.fn();
jest.mock("../../services/ytdlp", () => ({ extractPlaylist: (...a: unknown[]) => mockExtractPlaylist(...a) }));

import express from "express";
import request from "supertest";
import spotifyRoutes from "../spotify";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { deezerService } from "../../services/deezer";
import { spotifyService } from "../../services/spotify";
import { trackIdentityService } from "../../services/trackIdentity";
import { spotifyImportService } from "../../services/spotifyImport";
import { importQueue } from "../../workers/queues";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

const USER = "zz-dispatch-usr";
const app = express().use(express.json()).use("/spotify", spotifyRoutes);

const DEEZER = "https://www.deezer.com/en/playlist/90210";
const SPOTIFY = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M";
const YT_PLAYLIST = "https://www.youtube.com/playlist?list=PL123";
const YT_SINGLE = "https://www.youtube.com/watch?v=abc123";

let getDeezerPlaylist: jest.SpyInstance;
let getDeezerName: jest.SpyInstance;
let getSpotifyPlaylist: jest.SpyInstance;
let getSpotifyName: jest.SpyInstance;
let resolveUrl: jest.SpyInstance;
let processImport: jest.SpyInstance;
const jobIds: string[] = [];

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: "zz-dispatch-user", passwordHash: "x", role: "admin" } });
});

beforeEach(() => {
    getDeezerPlaylist = jest.spyOn(deezerService, "getPlaylist").mockResolvedValue({
        id: "90210", title: "Deezer Mix", description: null, creator: "someone", imageUrl: null, trackCount: 0, tracks: [],
    } as never);
    getDeezerName = jest.spyOn(deezerService, "getPlaylistName").mockResolvedValue("Deezer Mix");
    getSpotifyPlaylist = jest.spyOn(spotifyService, "getPlaylist").mockResolvedValue({
        id: "37i9dQZF1DXcBWIGoYBM5M", name: "Spotify Mix", description: null, owner: "spotify", imageUrl: null, trackCount: 0, tracks: [],
    } as never);
    getSpotifyName = jest.spyOn(spotifyService, "getPlaylistName").mockResolvedValue("Spotify Mix");
    mockExtractPlaylist.mockReset();
    mockExtractPlaylist.mockResolvedValue({
        id: "PL123", title: "YouTube Mix", uploader: "chan", platform: "YouTube",
        tracks: [{ id: "abc", title: "Song", artist: "Artist", album: null, duration: 1000, url: "https://www.youtube.com/watch?v=abc", thumbnailUrl: null, hasNativeMetadata: true }],
    });
    resolveUrl = jest.spyOn(trackIdentityService, "resolveUrl").mockResolvedValue({
        sourceUrl: YT_SINGLE, platform: "youtube", spotifyId: null, isrc: null, title: "Single Song", artist: "Single Artist",
        album: null, genres: [], tags: [], coverUrl: null, songLinkData: null,
    });
    processImport = jest.spyOn(spotifyImportService as never, "processImport").mockResolvedValue(undefined as never);
});

afterEach(async () => {
    jest.restoreAllMocks();
    for (const id of jobIds.splice(0)) {
        await redisClient.del(`preview:job:${id}`, `import:job:${id}`, `import:preview:${id}`);
        await (await importQueue.getJob(id))?.remove().catch(() => {});
        await prisma.spotifyImportJob.deleteMany({ where: { id } });
    }
});

afterAll(async () => {
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeQueue(importQueue);
    await closeEngineConnections();
});

/** Start a preview through the route and poll its result route until it finishes. */
async function preview(url: string): Promise<{ status: string; preview?: { playlist: { id: string; name: string } }; error?: string }> {
    const started = await request(app).post("/spotify/preview/start").send({ url }).expect(200);
    jobIds.push(started.body.jobId);
    for (let i = 0; i < 200; i++) {
        const res = await request(app).get(`/spotify/preview/${started.body.jobId}`).expect(200);
        if (res.body.status !== "pending") return res.body;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("preview never finished");
}

/** Queue a quick import through the route, then run what the queue worker runs for it (it reads the job's own `url`). */
async function quickImport(url: string) {
    const queued = await request(app).post("/spotify/import/quick").send({ url }).expect(200);
    const jobId: string = queued.body.jobId;
    jobIds.push(jobId);
    const data = (await importQueue.getJob(jobId))!.data as { url: string };
    await spotifyImportService.processQuickImportFromQueue(jobId, data.url);
    return (await request(app).get(`/spotify/import/${jobId}/status`).expect(200)).body;
}

describe("a preview", () => {
    it("of a Deezer playlist link asks Deezer for that playlist id", async () => {
        const result = await preview(DEEZER);
        expect(getDeezerPlaylist.mock.calls[0][0]).toBe("90210");
        expect(getSpotifyPlaylist).not.toHaveBeenCalled();
        expect(mockExtractPlaylist).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: "completed", preview: { playlist: { id: "90210", name: "Deezer Mix" } } });
    });

    it("of a Spotify playlist link takes the Spotify path", async () => {
        const result = await preview(SPOTIFY);
        expect(getSpotifyPlaylist.mock.calls[0][0]).toBe(SPOTIFY);
        expect(getDeezerPlaylist).not.toHaveBeenCalled();
        expect(mockExtractPlaylist).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: "completed", preview: { playlist: { id: "37i9dQZF1DXcBWIGoYBM5M", name: "Spotify Mix" } } });
    });

    it("of a YouTube playlist link gives yt-dlp the parsed address", async () => {
        const result = await preview(YT_PLAYLIST);
        expect(mockExtractPlaylist).toHaveBeenCalledTimes(1);
        expect(mockExtractPlaylist).toHaveBeenCalledWith(YT_PLAYLIST);
        expect(resolveUrl).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: "completed", preview: { playlist: { id: "PL123", name: "YouTube Mix" } } });
    });

    it("of a YouTube link with no playlist is one song, and yt-dlp is not run", async () => {
        const result = await preview(YT_SINGLE);
        expect(mockExtractPlaylist).not.toHaveBeenCalled();
        expect(resolveUrl).toHaveBeenCalledWith(YT_SINGLE);
        expect(result).toMatchObject({ status: "completed", preview: { playlist: { name: "youtube import" } } });
    });
});

describe("a quick import, as far as its fetch", () => {
    it("of a Deezer playlist link asks Deezer for that playlist id", async () => {
        const job = await quickImport("https://www.deezer.com/playlist/90210");
        expect(getDeezerPlaylist.mock.calls[0][0]).toBe("90210");
        expect(getDeezerName.mock.calls[0][0]).toBe("90210");
        expect(mockExtractPlaylist).not.toHaveBeenCalled();
        expect(processImport).toHaveBeenCalledTimes(1);
        expect(job).toMatchObject({ playlistName: "Deezer Mix", spotifyPlaylistId: "90210", status: "downloading" });
    });

    it("of a Spotify playlist link takes the Spotify path", async () => {
        const job = await quickImport(SPOTIFY);
        expect(getSpotifyPlaylist.mock.calls[0][0]).toBe(SPOTIFY);
        expect(getSpotifyName.mock.calls[0][0]).toBe(SPOTIFY);
        expect(getDeezerPlaylist).not.toHaveBeenCalled();
        expect(mockExtractPlaylist).not.toHaveBeenCalled();
        expect(job).toMatchObject({ playlistName: "Spotify Mix", spotifyPlaylistId: "37i9dQZF1DXcBWIGoYBM5M" });
    });

    it("of a YouTube playlist link gives yt-dlp the parsed address", async () => {
        const job = await quickImport(YT_PLAYLIST);
        expect(mockExtractPlaylist).toHaveBeenCalledWith(YT_PLAYLIST);
        expect(resolveUrl).not.toHaveBeenCalled();
        expect(job).toMatchObject({ playlistName: "YouTube Mix", spotifyPlaylistId: "PL123" });
    });

    it("of a YouTube watch link with no playlist is one song, and yt-dlp is not run", async () => {
        const job = await quickImport(YT_SINGLE);
        expect(mockExtractPlaylist).not.toHaveBeenCalled();
        expect(resolveUrl).toHaveBeenCalledWith(YT_SINGLE);
        expect(job.playlistName).toBe("youtube import");
    });
});

describe("a pasted link the person typed without https://", () => {
    const FULL_LINK_MESSAGE = { error: "Paste the full link, starting with https://" };
    const INVALID_URL = { error: "Invalid URL. Supported: Spotify, Deezer, YouTube, SoundCloud, Mixcloud." };

    it.each([
        "open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
        "www.youtube.com/playlist?list=PL123",
        "www.deezer.com/en/playlist/90210",
    ])("%s is told to paste the full link, by the preview and the quick import", async (url) => {
        for (const route of ["/spotify/preview/start", "/spotify/import/quick"]) {
            const res = await request(app).post(route).send({ url });
            expect(res.status).toBe(400);
            expect(res.body).toEqual(FULL_LINK_MESSAGE);
        }
        expect(getSpotifyPlaylist).not.toHaveBeenCalled();
        expect(mockExtractPlaylist).not.toHaveBeenCalled();
    });

    it.each([
        "https://youtube.com.evil.invalid/playlist?list=x",
        "https://evil.invalid/playlist/1",
        "evil.invalid/playlist/1",
        "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
        "not a url",
    ])("%s is refused as not a supported site, by the preview and the quick import", async (url) => {
        for (const route of ["/spotify/preview/start", "/spotify/import/quick"]) {
            const res = await request(app).post(route).send({ url });
            expect(res.status).toBe(400);
            expect(res.body).toEqual(INVALID_URL);
        }
    });
});
