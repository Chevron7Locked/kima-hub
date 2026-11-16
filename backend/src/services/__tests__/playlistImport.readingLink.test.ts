/**
 * Reading a music link into a list of songs, in the source's order, through the reading part's interface. Each
 * adapter (Spotify, Deezer, every other site by song.link and yt-dlp) answers with the same shape; what a site cannot
 * give is a message fit to show. The sites themselves are stood in for.
 */
jest.mock("../spotify", () => ({ spotifyService: { getPlaylist: jest.fn(), getPlaylistName: jest.fn() } }));
jest.mock("../deezer", () => ({ deezerService: { getPlaylist: jest.fn(), getPlaylistName: jest.fn() } }));
jest.mock("../trackIdentity", () => ({ trackIdentityService: { resolveUrl: jest.fn() } }));
jest.mock("../ytdlp", () => ({ extractPlaylist: jest.fn() }));

import { spotifyService } from "../spotify";
import { deezerService } from "../deezer";
import { trackIdentityService } from "../trackIdentity";
import { extractPlaylist } from "../ytdlp";
import { recogniseMusicLink } from "../musicLink";
import { readMusicLink, musicLinkName } from "../playlistImport/reading";

const spotify = spotifyService as unknown as Record<"getPlaylist" | "getPlaylistName", jest.Mock>;
const deezer = deezerService as unknown as Record<"getPlaylist" | "getPlaylistName", jest.Mock>;
const identity = trackIdentityService as unknown as { resolveUrl: jest.Mock };
const ytdlp = extractPlaylist as jest.Mock;

const link = (url: string) => recogniseMusicLink(url)!;

beforeEach(() => jest.resetAllMocks());

describe("a Spotify link", () => {
    const song = { spotifyId: "s1", title: "Song", artist: "Band", artistId: "", album: "Album", albumId: "", isrc: null, durationMs: 1, trackNumber: 1, previewUrl: null, coverUrl: null };

    it("reads as the playlist's songs and details, and reports the fetch and then the matching stage", async () => {
        spotify.getPlaylist.mockResolvedValue({ id: "p", name: "Mix", description: "d", owner: "me", imageUrl: "i", trackCount: 1, tracks: [song] });
        const stages: string[] = [];
        const onFetchProgress = jest.fn();

        const list = await readMusicLink(link("https://open.spotify.com/playlist/p"), { onFetchProgress, onStage: (s) => stages.push(s) });

        expect(list).toEqual({
            tracks: [song],
            playlist: { id: "p", name: "Mix", description: "d", owner: "me", imageUrl: "i", trackCount: 1 },
            source: "Spotify",
        });
        expect(spotify.getPlaylist).toHaveBeenCalledWith("https://open.spotify.com/playlist/p", onFetchProgress);
        expect(stages).toEqual(["matching"]);
    });

    it("says so when the playlist cannot be fetched", async () => {
        spotify.getPlaylist.mockResolvedValue(null);
        await expect(readMusicLink(link("https://open.spotify.com/playlist/p"))).rejects.toThrow("Could not fetch playlist from Spotify");
    });
});

describe("a Deezer link", () => {
    it("reads as the playlist's songs, with Spotify-shaped defaults for what Deezer leaves out", async () => {
        deezer.getPlaylist.mockResolvedValue({
            id: "90210", title: "Road trip", description: "", creator: "", imageUrl: "cover", trackCount: 0,
            tracks: [{ deezerId: "d1", title: "A", artist: "X", album: "", durationMs: 5, coverUrl: "" }, { deezerId: "d2", title: "B", artist: "Y", album: "Rec", trackNumber: 7 }],
        });
        const stages: string[] = [];

        const list = await readMusicLink(link("https://www.deezer.com/en/playlist/90210"), { onStage: (s) => stages.push(s) });

        expect(deezer.getPlaylist).toHaveBeenCalledWith("90210", undefined);
        expect(list.source).toBe("Deezer");
        expect(list.playlist).toEqual({ id: "90210", name: "Road trip", description: null, owner: "Deezer", imageUrl: "cover", trackCount: 2 });
        expect(list.tracks.map((t) => [t.spotifyId, t.album, t.trackNumber, t.isrc, t.coverUrl])).toEqual([
            ["d1", "Unknown Album", 1, null, "cover"],
            ["d2", "Rec", 7, null, "cover"],
        ]);
        expect(stages).toEqual(["matching"]);
    });

    it("refuses a link with no playlist id, and a playlist Deezer does not have", async () => {
        await expect(readMusicLink(link("https://www.deezer.com/en/album/5"))).rejects.toThrow("Invalid Deezer playlist URL");
        deezer.getPlaylist.mockResolvedValue(null);
        await expect(readMusicLink(link("https://www.deezer.com/playlist/9"))).rejects.toThrow("Deezer playlist not found");
    });
});

describe("any other site", () => {
    it("reads a single song through song.link, naming the playlist after the site", async () => {
        identity.resolveUrl.mockResolvedValue({ spotifyId: "sp9", title: "T", artist: "A", album: "", isrc: "ISRC1", coverUrl: "c" });
        const stages: string[] = [];

        const list = await readMusicLink(link("https://www.youtube.com/watch?v=abc"), { onStage: (s) => stages.push(s) });

        expect(stages).toEqual(["resolving"]);
        expect(list.source).toBe("youtube");
        expect(list.playlist).toMatchObject({ name: "youtube import", trackCount: 1, imageUrl: "c" });
        expect(list.tracks).toHaveLength(1);
        expect(list.tracks[0]).toMatchObject({ spotifyId: "sp9", title: "T", artist: "A", album: "Unknown Album", isrc: "ISRC1" });
    });

    it("says so when song.link cannot place a single song", async () => {
        identity.resolveUrl.mockResolvedValue(null);
        await expect(readMusicLink(link("https://soundcloud.com/a/b"))).rejects.toThrow("Could not resolve track from soundcloud URL");
    });

    it("reads a playlist through yt-dlp, keeping a song yt-dlp named itself and asking song.link only for the rest, in order", async () => {
        ytdlp.mockResolvedValue({
            id: "pl", title: "Set", platform: "soundcloud", uploader: "dj",
            tracks: [
                { url: "u0", title: "Raw 0", artist: "Raw A", album: null, duration: 10, thumbnailUrl: "t0", hasNativeMetadata: false },
                { url: "u1", title: "Native 1", artist: "Nat A", album: "Alb", duration: 20, thumbnailUrl: "t1", hasNativeMetadata: true },
            ],
        });
        identity.resolveUrl.mockResolvedValue({ spotifyId: "", title: "Clean 0", artist: "Clean A", album: "", isrc: null, coverUrl: null });

        const list = await readMusicLink(link("https://soundcloud.com/dj/sets/set"));

        expect(identity.resolveUrl).toHaveBeenCalledTimes(1);
        expect(list.playlist).toMatchObject({ id: "pl", name: "Set", owner: "dj", trackCount: 2 });
        expect(list.tracks.map((t) => [t.spotifyId, t.title, t.artist, t.album])).toEqual([
            ["ext-pl-0", "Clean 0", "Clean A", "Unknown Album"],
            ["ext-pl-1", "Native 1", "Nat A", "Alb"],
        ]);
    });

    it("falls back to yt-dlp's own words for a song song.link cannot place", async () => {
        ytdlp.mockResolvedValue({
            id: "pl", title: "Set", platform: "soundcloud", uploader: null,
            tracks: [{ url: "u0", title: "Raw 0", artist: "Raw A", album: null, duration: 10, thumbnailUrl: "t0", hasNativeMetadata: false }],
        });
        identity.resolveUrl.mockRejectedValue(new Error("song.link down"));

        const list = await readMusicLink(link("https://soundcloud.com/dj/sets/set"));

        expect(list.tracks[0]).toMatchObject({ title: "Raw 0", artist: "Raw A", coverUrl: "t0" });
    });

    it("says so when a playlist has no songs", async () => {
        ytdlp.mockResolvedValue({ id: "pl", title: "Empty", platform: "mixcloud", uploader: null, tracks: [] });
        await expect(readMusicLink(link("https://www.mixcloud.com/a/playlist/b"))).rejects.toThrow("No tracks found in mixcloud playlist");
    });
});

describe("the name a link's playlist carries", () => {
    it("is looked up for Deezer and Spotify, and absent for anything else", async () => {
        deezer.getPlaylistName.mockResolvedValue("Deezer name");
        spotify.getPlaylistName.mockResolvedValue("Spotify name");
        expect(await musicLinkName(link("https://www.deezer.com/playlist/12"))).toBe("Deezer name");
        expect(deezer.getPlaylistName).toHaveBeenCalledWith("12");
        expect(await musicLinkName(link("https://open.spotify.com/playlist/p"))).toBe("Spotify name");
        expect(await musicLinkName(link("https://soundcloud.com/a/sets/b"))).toBeUndefined();
    });

    it("is absent when the lookup finds none", async () => {
        deezer.getPlaylistName.mockResolvedValue(null);
        expect(await musicLinkName(link("https://www.deezer.com/playlist/12"))).toBeUndefined();
    });
});
