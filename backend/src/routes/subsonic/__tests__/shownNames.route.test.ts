/**
 * The last places that looked at the file's name instead of the name shown, and the last places that counted albums by
 * the cached number instead of by what plays. Real routers and the suite database:
 * - getLyrics finds a song by the title and artist as shown (and by the file's), for any script.
 * - getMusicDirectory (the root), getSimilarSongs and getTopSongs agree with getArtists on which artists have playable
 *   albums: a stale cached count decides nothing.
 * - getArtists and getIndexes carry `lastModified`, and file an artist under the accent-folded first letter of its sort
 *   name; a letter outside A-Z keeps its own bucket and "#" holds digits and symbols only.
 * - A playlist import finds a song by the title shown too, for any script.
 * - A podcast, episode or audiobook search with a non-ASCII letter reaches the same fields full-text search does.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";
import { libraryRouter } from "../library";
import { playbackRouter } from "../playback";
import { searchService } from "../../../services/search";
import { spotifyImportService } from "../../../services/spotifyImport";
import { deezerService } from "../../../services/deezer";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zzshn";
const USER = `${P}-user`;

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", searchRouter, libraryRouter, playbackRouter);

const ask = (view: string, query: Record<string, string>) =>
    request(app).get(`/${view}.view`).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : [x].flat() as T[]);

let seq = 0;
/** An artist with one library album holding one song, each named as given. */
async function seed(o: {
    artist: string; artistShown?: string | null; sortName?: string; song: string; songShown?: string | null;
    missing?: boolean; cached?: number; artistId?: string; lyrics?: string;
}) {
    const n = ++seq;
    const artistId = o.artistId ?? `${P}-ar-${n}`;
    if (!o.artistId) {
        await prisma.artist.create({
            data: {
                id: artistId, name: o.artist, displayName: o.artistShown ?? null, normalizedName: o.artist.toLowerCase(),
                identityKey: `${artistId}-ik`, sortName: o.sortName ?? o.artist.toLowerCase(), libraryAlbumCount: o.cached ?? 1,
            },
        });
    }
    await prisma.album.create({
        data: { id: `${P}-al-${n}`, rgMbid: `${P}-rg-${n}`, identityKey: `${P}-al-${n}`, artistId, title: `${P} album ${n}`, primaryType: "Album", location: "LIBRARY", year: 2005 },
    });
    await prisma.track.create({
        data: {
            id: `${P}-t-${n}`, albumId: `${P}-al-${n}`, title: o.song, displayTitle: o.songShown ?? null, trackNo: 1, duration: 100,
            filePath: `${P}-${n}.flac`, fileModified: new Date(), fileSize: 1, mime: "FLAC",
            ...(o.missing ? { missingSince: new Date() } : {}),
        },
    });
    if (o.lyrics) await prisma.trackLyrics.create({ data: { track_id: `${P}-t-${n}`, plain_lyrics: o.lyrics, source: "test" } });
    return { artistId, albumId: `${P}-al-${n}`, trackId: `${P}-t-${n}` };
}

const ids: Record<string, { artistId: string; albumId: string; trackId: string }> = {};

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.podcast.deleteMany({ where: { feedUrl: { startsWith: P } } });
    await prisma.audiobook.deleteMany({ where: { audioUrl: { startsWith: P } } });
    await prisma.similarArtist.deleteMany({ where: { fromArtistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });

    // getLyrics: the file's names are one set of words, the names shown another.
    ids.lyric = await seed({
        artist: "zzshnrawband", artistShown: "zzshnshownband", song: "zzshnraw lyric", songShown: "zzshnshown lyric", lyrics: "shown line",
    });
    ids.lyricUni = await seed({
        artist: "zzshnrawuni", artistShown: "zzshnshownuni", song: "zzshnraw ünï", songShown: "zzshnshown ÉCLAT", lyrics: "uni line",
    });

    // A stale cached count that says "none" for an artist who has a song that plays, and "five" for one whose only file is gone.
    ids.hidden = await seed({ artist: "zzshnhidden", song: "zzshnhidden song", cached: 0 });
    ids.ghost = await seed({ artist: "zzshnghost", song: "zzshnghost song", missing: true, cached: 5 });
    ids.base = await seed({ artist: "zzshnbase", song: "zzshnbase song" });
    await prisma.similarArtist.createMany({
        data: [ids.hidden, ids.ghost].map((x) => ({ fromArtistId: ids.base.artistId, toArtistId: x.artistId, weight: 1 })),
    });

    // Index buckets, by sort name.
    ids.bucketO = await seed({ artist: "zzshn oresund", sortName: "Özzshn" , song: "zzshn b1" });
    ids.bucketE = await seed({ artist: "zzshn eclair", sortName: "éclair zzshn", song: "zzshn b2" });
    ids.bucketZh = await seed({ artist: "zzshn zhuk", sortName: "Жzzshn", song: "zzshn b3" });
    ids.bucketDigit = await seed({ artist: "zzshn 9", sortName: "9zzshn", song: "zzshn b4" });
    ids.bucketSymbol = await seed({ artist: "zzshn bang", sortName: "!zzshn", song: "zzshn b5" });
    ids.bucketPlain = await seed({ artist: "zzshn plain", sortName: "plain zzshn", song: "zzshn b6" });

    // Import: songs whose shown title is not the file's, and one that is found by the file's.
    ids.impAscii = await seed({ artist: "zzshn impband one", song: "zzshn fileword alpha", songShown: "zzshn shownword alpha" });
    ids.impUni = await seed({ artist: "zzshn impband two", song: "zzshn fileword beta", songShown: "zzshn élan shownword beta" });
    ids.impRaw = await seed({ artist: "zzshn impband three", song: "zzshn fileword gamma", songShown: "zzshn shownword gamma" });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("getLyrics matches the title and artist as shown", () => {
    const lyricsOf = async (query: Record<string, string>) => (await ask("getLyrics", query)).lyrics;

    it("finds a song by its shown title, and the answer is named as shown", async () => {
        expect(await lyricsOf({ title: "zzshnshown lyric" })).toMatchObject({ artist: "zzshnshownband", title: "zzshnshown lyric", value: "shown line" });
    });

    it("still finds it by the file's title", async () => {
        expect(await lyricsOf({ title: "zzshnraw lyric" })).toMatchObject({ title: "zzshnshown lyric", value: "shown line" });
    });

    it("finds it by the artist as shown, and by the artist's own name", async () => {
        expect(await lyricsOf({ artist: "zzshnshownband", title: "shown lyric" })).toMatchObject({ value: "shown line" });
        expect(await lyricsOf({ artist: "zzshnrawband", title: "shown lyric" })).toMatchObject({ value: "shown line" });
        expect(await lyricsOf({ artist: "ZZSHNSHOWNBAND" })).toMatchObject({ value: "shown line" });
    });

    it("keeps the artist exact: another artist's song is not the answer", async () => {
        expect(await lyricsOf({ artist: "zzshnshown", title: "shown lyric" })).toEqual({});
        expect(await lyricsOf({ artist: "zzshnshownuni", title: "shown lyric" })).toEqual({});
    });

    it("matches a title with a non-ASCII letter by the title shown, in either letter case", async () => {
        expect(await lyricsOf({ title: "zzshnshown éclat" })).toMatchObject({ value: "uni line" });
        expect(await lyricsOf({ title: "ÉCLAT" })).toMatchObject({ value: "uni line" });
        expect(await lyricsOf({ title: "zzshnraw ÜNÏ" })).toMatchObject({ value: "uni line" });
        expect(await lyricsOf({ artist: "zzshnshownuni", title: "éclat" })).toMatchObject({ value: "uni line" });
    });
});

describe("one playable album count across Subsonic", () => {
    const rootArtistIds = async () => {
        const body = await ask("getMusicDirectory", { id: "1" });
        return list<any>(body.directory.child).map((c) => c.id);
    };

    it("getMusicDirectory (the root) lists an artist with a playable album whatever the cached count says", async () => {
        const root = await rootArtistIds();
        expect(root).toContain(ids.hidden.artistId);
        expect(root).not.toContain(ids.ghost.artistId);
    });

    it("agrees with getArtists", async () => {
        const body = await ask("getArtists", {});
        const inArtists = list<any>(body.artists.index).flatMap((i) => list<any>(i.artist)).map((a) => a.id).filter((id) => id.startsWith(P));
        const inRoot = (await rootArtistIds()).filter((id) => id.startsWith(P));
        expect(inRoot.sort()).toEqual(inArtists.sort());
    });

    it("getSimilarSongs offers the songs of a similar artist with a playable album, and none of one without", async () => {
        const body = await ask("getSimilarSongs2", { id: ids.base.trackId, count: "50" });
        const songs = list<any>(body.similarSongs2.song).map((s) => s.id);
        expect(songs).toContain(ids.hidden.trackId);
        expect(songs).not.toContain(ids.ghost.trackId);
    });

    describe("getTopSongs", () => {
        beforeEach(() => void jest.spyOn(deezerService, "getArtistTopTracks").mockResolvedValue([]));
        afterEach(() => jest.restoreAllMocks());

        it("finds an artist with a playable album whatever the cached count says", async () => {
            const body = await ask("getTopSongs", { artist: "zzshnhidden" });
            expect(list<any>(body.topSongs.song).map((s) => s.id)).toEqual([ids.hidden.trackId]);
        });

        it("finds nothing for an artist with no playable album", async () => {
            const body = await ask("getTopSongs", { artist: "zzshnghost" });
            expect(body.topSongs.song).toBeUndefined();
        });
    });
});

describe("getArtists and getIndexes", () => {
    const bucketsOf = (body: any, key: "artists" | "indexes") =>
        Object.fromEntries(
            list<any>(body[key].index).map((i) => [i.name, list<any>(i.artist).map((a) => a.id).filter((id) => id.startsWith(P))]),
        );

    it.each([["getArtists", "artists"], ["getIndexes", "indexes"]] as const)("%s files an artist under the folded first letter of its sort name", async (view, key) => {
        const buckets = bucketsOf(await ask(view, {}), key);
        expect(buckets["O"]).toContain(ids.bucketO.artistId);
        expect(buckets["E"]).toContain(ids.bucketE.artistId);
        expect(buckets["P"]).toContain(ids.bucketPlain.artistId);
    });

    it("keeps a letter outside A-Z in its own bucket, and '#' for digits and symbols only", async () => {
        const buckets = bucketsOf(await ask("getArtists", {}), "artists");
        expect(buckets["Ж"]).toEqual([ids.bucketZh.artistId]);
        expect((buckets["#"] ?? []).sort()).toEqual([ids.bucketDigit.artistId, ids.bucketSymbol.artistId].sort());
        for (const [name, artists] of Object.entries(buckets)) {
            if (name !== "#") expect(artists).not.toContain(ids.bucketDigit.artistId);
        }
    });

    it("gives lastModified (milliseconds since the epoch), and it moves when a song does", async () => {
        const before = await ask("getArtists", {});
        const asMs = before.artists.lastModified;
        expect(Number.isInteger(asMs)).toBe(true);
        const newest = await prisma.track.aggregate({ _max: { updatedAt: true } });
        expect(asMs).toBeGreaterThanOrEqual(newest._max.updatedAt!.getTime());

        await new Promise((r) => setTimeout(r, 15));
        await prisma.track.update({ where: { id: ids.base.trackId }, data: { trackNo: 2 } });
        const after = await ask("getIndexes", {});
        expect(after.indexes.lastModified).toBeGreaterThan(asMs);
    });
});

describe("a playlist import finds a song by the title shown too", () => {
    async function imported(spotifyTitle: string, n: number) {
        const playlistId = `${P}-playlist-${n}`;
        await prisma.playlist.create({ data: { id: playlistId, userId: USER, name: playlistId } });
        // An artist nobody has, so only the title-only lookup can answer.
        await prisma.playlistPendingTrack.create({
            data: { playlistId, spotifyArtist: "Nobody Anyone", spotifyTitle, spotifyAlbum: "x", sort: 0, rank: "a0" },
        });
        await spotifyImportService.reconcilePendingTracks(playlistId);
        return (await prisma.playlistItem.findMany({ where: { playlistId } })).map((i) => i.trackId);
    }

    it("by the shown title", async () => {
        expect(await imported("zzshn shownword alpha", 1)).toEqual([ids.impAscii.trackId]);
    });

    it("by the shown title with a non-ASCII letter, in another letter case", async () => {
        expect(await imported("ZZSHN ÉLAN SHOWNWORD BETA", 2)).toEqual([ids.impUni.trackId]);
    });

    it("by the file's title, as before", async () => {
        expect(await imported("zzshn fileword gamma", 3)).toEqual([ids.impRaw.trackId]);
    });
});

describe("a non-ASCII search of podcasts, episodes and audiobooks", () => {
    const FEED = `${P}-feed`;
    let podcastId: string;

    beforeAll(async () => {
        const podcast = await prisma.podcast.create({
            data: { feedUrl: FEED, title: "zzshn show", author: "Zoë Zzshn", description: "Über zzshn stories" },
        });
        podcastId = podcast.id;
        await prisma.podcastSubscription.create({ data: { userId: USER, podcastId } });
        await prisma.podcastEpisode.create({
            data: { podcastId, guid: `${P}-ep`, title: "zzshn episode", description: "Café zzshn talk", audioUrl: `${P}-ep.mp3`, publishedAt: new Date() },
        });
        await prisma.audiobook.create({
            data: {
                title: "zzshn book", author: "Zoë Zzshn", narrator: "Renée Zzshn", series: "Ñandú zzshn", description: "Über zzshn tale",
                audioUrl: `${P}-book.mp3`,
            },
        });
    });

    it("reaches a podcast's author and description", async () => {
        const byAuthor = await searchService.searchPodcastsFTS({ query: "zoë", userId: USER });
        expect(byAuthor.map((p) => p.id)).toContain(podcastId);
        const byDescription = await searchService.searchPodcastsFTS({ query: "ÜBER zzshn", userId: USER });
        expect(byDescription.map((p) => p.id)).toContain(podcastId);
    });

    it("reaches an episode's description", async () => {
        const found = await searchService.searchEpisodes({ query: "CAFÉ zzshn", userId: USER });
        expect(found.map((e) => e.title)).toContain("zzshn episode");
    });

    it("reaches an audiobook's author, narrator, series and description", async () => {
        for (const query of ["zoë", "renée", "ñandú", "ÜBER zzshn"]) {
            const found = await searchService.searchAudiobooksFTS({ query });
            expect(found.map((b) => b.title)).toContain("zzshn book");
        }
    });
});
