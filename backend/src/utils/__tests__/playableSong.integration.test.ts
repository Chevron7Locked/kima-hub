/**
 * A playable song is a song on a library album whose file is there and was read. Every interface that picks songs
 * offers only playable ones; this file seeds one playable song and three that are not (a Discover song, a missing
 * file, a corrupt file) and calls each of those interfaces. An interface that moves onto the rule adds its row to
 * PICKERS (it lists songs) or its route to STREAMS (it plays one). Real database, real routers, real files.
 */
jest.mock("../../config", () => {
    const actual = jest.requireActual("../../config");
    const base = require("path").join(require("os").tmpdir(), `kima-playable-${process.pid}`);
    Object.assign(actual.config.music, { musicPath: `${base}/music`, transcodeCachePath: `${base}/cache` });
    return actual;
});
// The web routers sit behind the sign-in check; here the test's own user stands in for a signed-in one.
jest.mock("../../middleware/auth", () => {
    const actual = jest.requireActual("../../middleware/auth");
    return { ...actual, requireAuthOrToken: (req: any, res: any, next: any) => (req.user ? next() : actual.requireAuthOrToken(req, res, next)) };
});

import express from "express";
import request from "supertest";
import fs from "fs";
import zlib from "zlib";
import path from "path";
import { prisma } from "../db";
import { artistIdentityKey, normalizeArtistName } from "../../services/artistIdentity";
import { config } from "../../config";
import { PLAYABLE_SONG, playableSongSql } from "../playableSong";
import { albumHasPlayableSongSql, artistHasPlayableSongSql } from "../../services/libraryFilters";
import { compatRouter } from "../../routes/subsonic/compat";
import { playbackRouter } from "../../routes/subsonic/playback";
import { searchRouter } from "../../routes/subsonic/search";
import { libraryRouter } from "../../routes/subsonic/library";
import { starredRouter } from "../../routes/subsonic/starred";
import { playlistRouter } from "../../routes/subsonic/playlists";
import { queueRouter } from "../../routes/subsonic/queue";
import { lyricsRouter } from "../../routes/subsonic/lyrics";
import { Prisma } from "@prisma/client";
import { redisClient } from "../redis";
import * as artistSimilarity from "../../services/artistSimilarity";
import { sampleTrackIds, sampledMix, seededTrackIds, tracksByIds, unplayedTrackIds } from "../../services/mixes/helpers";
import { generateArtistSimilarMix, generateRandomDiscoveryMix, generateRediscoverMix, generateTopTracksMix } from "../../services/mixes/discoveryMixes";
import { generateEraMix, generateGenreMix } from "../../services/mixes/genreMixes";
import { seedsOf } from "../../services/mixes/familiarity";
import { nightMixTracks, nightSongs } from "../../services/mixes/nightPlays";
import { generateMinorKeyMix } from "../../services/mixes/moodMixes";
import { selectRadioTracks } from "../../services/mixes/stationSelection";
import { stationCovers, type CoverStationType } from "../../services/mixes/stationCovers";
import { libraryDecades, libraryGenres, radioRow } from "../../services/mixes/radioRow";
import { nightStationPool } from "../../services/mixes/nightPlays";
import { featureDetection } from "../../services/featureDetection";
import { findSimilarTracks } from "../../services/hybridSimilarity";
import { generateSongPath } from "../../services/songPath";
import { refreshLibraryExport } from "../../services/publicLibraryExport";
import { getMoodSummary, getVibeMap } from "../../services/vibeMap";
import { searchTracksByEmbedding } from "../../services/textEmbeddingBridge";
import { searchService } from "../../services/search";
import { artistProfiles, matchingContext, rankMatches, scoreLibrary, topScores } from "../../services/matching/rank";
import { MATCHING_MODEL, buildMatching, loadMatchingState } from "../../services/matching/state";
import { updateMap } from "../../services/matching/map";
import { MOODS, MOOD_HEADS, type Mood } from "../../services/moods/heads";
import { buildMoodState } from "../../services/moods/state";
import { writeMoodTags } from "../../services/moods/tags";
import { currentMoodSnapshot, refreshMoodSnapshot } from "../../services/moodBucketService";
import { playableSlice, type Slice } from "../../services/stats/playable";
import { shelfStats } from "../../services/stats/shelf";
import { signature } from "../../services/stats/signature";
import libraryTracksRouter from "../../routes/library/tracks";
import libraryArtistsRouter, { resolveSimilarArtists } from "../../routes/library/artists";
import libraryAlbumsRouter from "../../routes/library/albums";
import playlistsRouter from "../../routes/playlists";
import { updateArtistCounts } from "../../services/artistCountsService";
import { libraryArtistIdsForGenre } from "../genreSql";
import recommendationsRouter from "../../routes/recommendations";
import { deezerService } from "../../services/deezer";
import { dataCacheService } from "../../services/dataCache";
import { spotifyService } from "../../services/spotify";
import { spotifyImportService } from "../../services/spotifyImport";
import { discoverWeeklyService } from "../../services/discoverWeekly";

jest.setTimeout(120_000);

const P = "zz-playable";
const USER = `${P}-user`;
const SONG = { playable: `${P}-ok`, discover: `${P}-discover`, missing: `${P}-missing`, corrupt: `${P}-corrupt` } as const;
const UNPLAYABLE: string[] = [SONG.discover, SONG.missing, SONG.corrupt];
const BYTES = Buffer.from("fLaC-playable-song-bytes");
/** A year and a genre only the seeded songs carry, so a list narrowed by them holds only these. */
const YEAR = 1901;
/** Every seeded song's key, so the stats page's key slice holds them all. */
const KEY = "A";
const GENRE = `${P}-genre`;
const PLAYLIST = `${P}-playlist`;
/** The other library artists, each with one album of two playable songs. */
const FILLERS = Array.from({ length: 9 }, (_, i) => `${P}-f${i}`);
/** Someone else listening to one seeded song, so the now-playing list has each to offer. */
const listenerOf = (kind: string) => `${P}-listener-${kind}`;
/** A listener with one night play, of a filler song: the Late Night station fills the rest with songs like it. */
const NIGHT = `${P}-night`;

/**
 * Each song's sound vector: the seeded songs share one sound, each with a trace of its own, and each filler has its own
 * beside it, so every song is near every other and an artist's profile tells which of its songs it was built from.
 */
const SEEDED: ReadonlySet<string> = new Set(Object.values(SONG));
function soundOf(id: string, i: number): number[] {
    const v = Array<number>(MOOD_HEADS.dims).fill(0);
    v[0] = 1;
    if (SEEDED.has(id)) {
        v[1] = 1;
        v[100 + Object.values(SONG).indexOf(id as never)] = 0.1;
    } else v[2 + i] = 1;
    return v;
}
/** The seeded songs' mood scores (logits): high on every mood the Energy station and Workout lean toward, low on the ones they push away. */
const ENERGETIC: Partial<Record<Mood, number>> = {
    workout: 3, energetic: 3, uplifting: 3, party: 3, groovy: 3, happy: 3, fun_quirky: 3, calm: -3, sleep: -3, sad: -3,
};

const app = express()
    .use(express.json())
    .use((req: any, _res, next) => {
        // The web routes can be asked as another user, named in `x-user`.
        const id = req.get("x-user") ?? USER;
        req.user = { id, username: id, role: "user" };
        next();
    })
    .use("/rest", compatRouter, playbackRouter, searchRouter, libraryRouter, starredRouter, playlistRouter, queueRouter, lyricsRouter)
    .use("/api/library", libraryTracksRouter, libraryArtistsRouter, libraryAlbumsRouter)
    .use("/api/playlists", playlistsRouter)
    .use("/api/recommendations", recommendationsRouter);
/** A web route's JSON answer, asked as `user`. */
const web = async (route: string, user = USER) => (await request(app).get(route).set("x-user", user).expect(200)).body;
const subsonic = (route: string, query: Record<string, string | string[]>) =>
    request(app).get(`/rest/${route}`).query({ u: USER, f: "json", ...query });

const reply = async (route: string, query: Record<string, string>) =>
    (await subsonic(route, query).expect(200)).body["subsonic-response"];
const idsOf = (songs: { "id"?: string }[] | undefined): string[] => (songs ?? []).map((s) => s.id!);
/** Each seeded song is alone on its album, so an album listed stands for its song. */
const songsOfAlbums = (albums: { id: string }[] | undefined): string[] => {
    const ids = (albums ?? []).map((a) => a.id);
    return Object.values(SONG).filter((id) => ids.includes(`${id}-al`));
};
/** Every page of an album list, so the seeded albums are found wherever they sort. */
async function everyAlbum(route: string, key: string, query: Record<string, string>) {
    const all: { id: string }[] = [];
    for (let offset = 0; ; offset += 500) {
        const page = (await reply(route, { ...query, size: "500", offset: String(offset) }))[key].album ?? [];
        all.push(...page);
        if (page.length < 500 || query.type === "random") return all;
    }
}
/** The day every mix is drawn for: a Monday, so the weekly mixes are made too. */
const TODAY = "2026-11-09";
const ourSongs = Prisma.sql`t.id LIKE ${`${P}%`}`;
const mixSongs = async (mix: Promise<{ trackIds: string[] } | null>) => {
    const made = await mix;
    if (!made) throw new Error("no mix was made from the seeded library");
    return made.trackIds;
};
/** The songs a station plays for USER. */
async function station(type: string, value?: string): Promise<string[]> {
    const picked = await selectRadioTracks(type, value, {}, 50, USER);
    if ("reply" in picked) throw new Error(`the ${type} station answered ${picked.reply.status}`);
    return picked.trackIds;
}
/** USER's cover for a station, picked afresh (the day's pick is kept in Redis, so it is cleared first). */
async function stationCover(type: CoverStationType, value?: string): Promise<string | null> {
    const keys = await redisClient.keys(`radiocover:${USER}:*`);
    if (keys.length) await redisClient.del(...keys);
    const [cover] = await stationCovers([{ type, value }], USER, "UTC");
    return cover;
}
const STATION_TYPES: [string, string | undefined][] = [
    ["all", undefined], ["discovery", undefined], ["favorites", undefined], ["decade", "1900"], ["genre", GENRE], ["artist", `${P}-ar`],
    ["mood", "energy"], ["mood", "wildcard"], ["workout", undefined],
];
/** The song the matching is asked about: a filler, so the seeded songs are among its matches. */
const NEAR = `${FILLERS[0]}-s1`;
async function matching() {
    const ctx = await matchingContext([NEAR]);
    if (!ctx) throw new Error("the seeded song has no matching data");
    return { ctx, inputs: [{ trackId: NEAR, weight: 1 }] };
}
/** A stats-page slice's songs, asked as `userId`. */
const slice = async (slice: Slice, userId = USER, extra: { key?: string; decade?: number } = {}) =>
    (await playableSlice({ userId, slice, limit: 100, ...extra })).map((t) => t.id);
/**
 * The web artist page, asked as `user`. `global` is the top list Deezer answers with, as titles of the seeded songs; an
 * empty one sends its popular songs to the listener's own plays, then (for a listener with none) to release order.
 */
async function artistPage(global: string[], user = USER) {
    const top = jest.spyOn(deezerService, "getArtistTopTracks").mockResolvedValue(
        global.map((title, i) => ({ title, album: title, coverUrl: null, previewUrl: null, durationMs: 100_000, rank: 100 - i })) as never,
    );
    const image = jest.spyOn(dataCacheService, "getArtistImage").mockResolvedValue(null);
    const similar = jest.spyOn(artistSimilarity, "getSimilarArtists").mockResolvedValue([]);
    try {
        return await web(`/api/library/artists/${P}-ar`, user);
    } finally {
        top.mockRestore();
        image.mockRestore();
        similar.mockRestore();
        // The page keeps the artist's similar artists for a day; cleared after each read so no read sees another's.
        await redisClient.del(`similar-artists-list:${P}-ar`);
    }
}
const popularSongs = async (global: string[], user = USER): Promise<string[]> =>
    (await artistPage(global, user)).topTracks.map((t: { id: string }) => t.id);
const ALBUM_LIST_TYPES = ["newest", "alphabeticalByName", "alphabeticalByArtist", "byYear", "byGenre", "starred", "random", "recent", "frequent"];

/** A song's title as the seeded library holds it, and so as an import's source names it. */
const titleOf = (kind: string) => `${P} ${kind}`;
const KINDS = Object.keys(SONG);
const NOBODY = "Nobody Anyone";
const pendingOf = (over: Record<string, unknown>) => ({
    artist: NOBODY, title: "nothing alike at all", album: "x", albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null, ...over,
});
let importCount = 0;
/** The songs in the playlist `name`, which is then removed so the next read starts from none. */
async function songsInPlaylistNamed(name: string): Promise<string[]> {
    const playlist = await prisma.playlist.findFirstOrThrow({ where: { userId: USER, name }, include: { items: true } });
    await prisma.playlist.delete({ where: { id: playlist.id } });
    return playlist.items.map((i) => i.trackId);
}
/** The songs an import's playlist build picks for these pending songs. */
async function importBuilt(pending: ReturnType<typeof pendingOf>[]): Promise<string[]> {
    const id = `${P}-build-${++importCount}`;
    const preview = jest.spyOn(deezerService, "getTrackPreview").mockResolvedValue(null as never);
    try {
        await (spotifyImportService as any).buildPlaylist({
            id, userId: USER, spotifyPlaylistId: "pl", playlistName: id, status: "scanning", progress: 80, albumsTotal: 0, albumsCompleted: 0,
            tracksMatched: 0, tracksTotal: pending.length, tracksDownloadable: 0, createdPlaylistId: null, error: null, sourceUrl: null,
            createdAt: new Date(), updatedAt: new Date(), pendingTracks: pending,
        });
    } finally {
        preview.mockRestore();
        await redisClient.del(`import:job:${id}`);
    }
    return songsInPlaylistNamed(id);
}
/** The songs a refresh adds to the playlist of an import that is waiting for them. */
async function importRefreshed(pending: ReturnType<typeof pendingOf>[]): Promise<string[]> {
    const id = `${P}-refresh-${++importCount}`;
    await prisma.playlist.create({ data: { id, userId: USER, name: id } });
    await prisma.spotifyImportJob.create({
        data: { id, userId: USER, spotifyPlaylistId: "pl", playlistName: id, status: "completed", albumsTotal: 0, tracksTotal: pending.length, createdPlaylistId: id, pendingTracks: pending as never },
    });
    try {
        await spotifyImportService.refreshJobMatches(id);
    } finally {
        await redisClient.del(`import:job:${id}`);
        await prisma.spotifyImportJob.delete({ where: { id } });
    }
    return songsInPlaylistNamed(id);
}
/** The songs a scan's reconcile adds to a playlist that was waiting for them. */
async function importReconciled(pending: { artist: string; title: string }[]): Promise<string[]> {
    const id = `${P}-reconcile-${++importCount}`;
    await prisma.playlist.create({ data: { id, userId: USER, name: id } });
    await prisma.playlistPendingTrack.createMany({
        data: pending.map((p, i) => ({ playlistId: id, spotifyArtist: p.artist, spotifyTitle: p.title, spotifyAlbum: "x", sort: i, rank: `a${i}` })),
    });
    await spotifyImportService.reconcilePendingTracks(id);
    return songsInPlaylistNamed(id);
}
/** The songs an import preview matched. */
const previewMatches = (preview: Promise<{ matchedTracks: { localTrack: { id: string } | null }[] }>) =>
    preview.then((p) => p.matchedTracks.flatMap((m) => (m.localTrack ? [m.localTrack.id] : [])));
const sourceTrack = (over: Record<string, unknown>) => ({
    spotifyId: "s", title: "nothing alike at all", artist: NOBODY, artistId: "", album: "x", albumId: "", isrc: null, durationMs: 100_000,
    trackNumber: 1, previewUrl: null, coverUrl: null, ...over,
});
/** The songs an M3U import puts in its playlist for these entries. */
async function m3uMatches(entries: { filePath: string; artist?: string; title?: string }[]): Promise<string[]> {
    const name = `${P}-m3u-${++importCount}`;
    await spotifyImportService.importFromM3U(USER, name, entries.map((e) => ({ durationSeconds: 100, ...e })) as never);
    return songsInPlaylistNamed(name);
}

/** Every interface that lists songs, each answering the ids it offers. */
const PICKERS: Record<string, () => Promise<string[]>> = {
    "the rule as a Prisma where piece": async () =>
        (await prisma.track.findMany({ where: { ...PLAYABLE_SONG, id: { startsWith: P } }, select: { id: true } })).map((t) => t.id),
    "the rule as a SQL fragment": async () =>
        (
            await prisma.$queryRaw<{ id: string }[]>`
                SELECT song.id FROM "Track" song JOIN "Album" a ON a.id = song."albumId"
                WHERE song.id LIKE ${`${P}%`} AND ${playableSongSql("song", "a")}`
        ).map((t) => t.id),
    "the rule as a SQL fragment on the bare table names": async () =>
        (
            await prisma.$queryRaw<{ id: string }[]>`
                SELECT "Track".id FROM "Track" JOIN "Album" ON "Album".id = "Track"."albumId"
                WHERE "Track".id LIKE ${`${P}%`} AND ${playableSongSql("Track", "Album")}`
        ).map((t) => t.id),
    "Subsonic search3 by title": async () => {
        const body = (await subsonic("search3.view", { query: P, songCount: "50" }).expect(200)).body["subsonic-response"];
        return (body.searchResult3.song ?? []).map((s: { id: string }) => s.id);
    },
    "Subsonic search3 over the whole library": async () => {
        const body = (await subsonic("search3.view", { query: "", songCount: "10000", artistCount: "0", albumCount: "0" }).expect(200))
            .body["subsonic-response"];
        return (body.searchResult3.song ?? []).map((s: { id: string }) => s.id).filter((id: string) => id.startsWith(P));
    },
    "Subsonic search3 for an album, which lists only albums with a playable song": async () => {
        const body = (await subsonic("search3.view", { query: "", songCount: "0", artistCount: "0", albumCount: "10000" }).expect(200))
            .body["subsonic-response"];
        const albums: string[] = (body.searchResult3.album ?? []).map((a: { id: string }) => a.id);
        // Each seeded song is alone on its album, so an album listed stands for its song.
        return Object.values(SONG).filter((id) => albums.includes(`${id}-al`));
    },
    "Subsonic getAlbum": async () =>
        (await Promise.all(Object.values(SONG).map((id) => reply("getAlbum.view", { id: `${id}-al` })))).flatMap((r) => idsOf(r.album?.song)),
    "Subsonic getMusicDirectory for an album": async () =>
        (await Promise.all(Object.values(SONG).map((id) => reply("getMusicDirectory.view", { id: `${id}-al` })))).flatMap((r) =>
            idsOf(r.directory?.child),
        ),
    "Subsonic getMusicDirectory for the artist, which lists only albums with a playable song": async () =>
        songsOfAlbums((await reply("getMusicDirectory.view", { id: `${P}-ar` })).directory.child),
    "Subsonic getArtist, which lists only albums with a playable song": async () =>
        songsOfAlbums((await reply("getArtist.view", { id: `${P}-ar` })).artist.album),
    ...Object.fromEntries(
        ["getAlbumList2", "getAlbumList"].flatMap((route) =>
            ALBUM_LIST_TYPES.map((type) => [
                `Subsonic ${route} ${type}, which lists only albums with a playable song`,
                async () =>
                    songsOfAlbums(
                        await everyAlbum(`${route}.view`, route === "getAlbumList2" ? "albumList2" : "albumList", {
                            type,
                            fromYear: String(YEAR),
                            toYear: String(YEAR),
                            genre: GENRE,
                        }),
                    ),
            ]),
        ),
    ),
    "Subsonic getStarred2": async () => idsOf((await reply("getStarred2.view", {})).starred2.song),
    "Subsonic getStarred": async () => idsOf((await reply("getStarred.view", {})).starred.song),
    "Subsonic getRandomSongs": async () =>
        idsOf((await reply("getRandomSongs.view", { size: "500", fromYear: String(YEAR), toYear: String(YEAR) })).randomSongs.song),
    "Subsonic getSongsByGenre": async () => idsOf((await reply("getSongsByGenre.view", { genre: GENRE, count: "500" })).songsByGenre.song),
    "Subsonic getTopSongs": async () => {
        // Deezer ranks every seeded song; Subsonic offers the playable one alone.
        const top = jest.spyOn(deezerService, "getArtistTopTracks").mockResolvedValue(
            Object.keys(SONG).map((kind, i) => ({ title: `${P} ${kind}`, album: null, coverUrl: null, previewUrl: null, durationMs: 100_000, rank: 100 - i })) as never,
        );
        try {
            return idsOf((await reply("getTopSongs.view", { artist: P, count: "500" })).topSongs.song);
        } finally {
            top.mockRestore();
        }
    },
    "Subsonic getSimilarSongs2": async () =>
        idsOf((await reply("getSimilarSongs2.view", { id: SONG.playable, count: "500" })).similarSongs2.song),
    "Subsonic getSimilarSongs": async () =>
        idsOf((await reply("getSimilarSongs.view", { id: SONG.playable, count: "500" })).similarSongs.song),
    "Subsonic getPlaylist": async () => idsOf((await reply("getPlaylist.view", { id: PLAYLIST })).playlist.entry),
    "Subsonic getPlayQueue": async () => idsOf((await reply("getPlayQueue.view", {})).playQueue.entry),
    "Subsonic getPlayQueueByIndex": async () => idsOf((await reply("getPlayQueueByIndex.view", {})).playQueueByIndex.entry),
    "Subsonic getNowPlaying": async () =>
        idsOf((await reply("getNowPlaying.view", {})).nowPlaying.entry).filter((id) => id.startsWith(P)),
    "Subsonic getBookmarks": async () =>
        ((await reply("getBookmarks.view", {})).bookmarks.bookmark ?? []).map((b: { entry: { id: string } }) => b.entry.id),
    "mix helper tracksByIds": async () => (await tracksByIds([...Object.values(SONG)], {})).map((t) => t.id),
    "mix helper sampleTrackIds": () => sampleTrackIds({ where: { id: { startsWith: P } }, take: 500 }),
    "mix helper seededTrackIds": () => seededTrackIds(ourSongs, 500, 1),
    "mix helper sampledMix": () =>
        mixSongs(sampledMix({ id: "x", type: "x", name: "x", description: "x", colorType: "x", seed: 1, where: ourSongs, minTracks: 5, limit: 500 })),
    "mix helper unplayedTrackIds": async () => (await unplayedTrackIds({ userId: listenerOf("playable") })).filter((id) => id.startsWith(P)),
    "Your Top 20 mix": () => mixSongs(generateTopTracksMix(USER)),
    "Rediscover mix": () => mixSongs(generateRediscoverMix(USER, TODAY)),
    "More Like mix": async () => {
        // The one call off the server: every seeded artist is similar.
        const artists = await prisma.artist.findMany({ where: { id: { startsWith: P } }, select: { name: true } });
        const similar = jest.spyOn(artistSimilarity, "getSimilarArtists").mockResolvedValue(artists.map((a) => ({ name: a.name })) as never);
        try {
            return await mixSongs(generateArtistSimilarMix(USER));
        } finally {
            similar.mockRestore();
        }
    },
    "Random Discovery mix": () => mixSongs(generateRandomDiscoveryMix(USER, TODAY)),
    "decade mix": () => mixSongs(generateEraMix(USER, TODAY)),
    "genre mix": () => mixSongs(generateGenreMix(USER, TODAY)),
    "familiar songs a recipe mix is lifted towards": async () => (await seedsOf(USER, new Date())).map((s) => s.id),
    "night songs of the night mixes and station": async () => (await nightSongs(USER, "UTC")).map((s) => s.id),
    "Late Night mix": async () => (await nightMixTracks({ fallbackRecipe: "late-night", ranking: "plays" }, USER, TODAY, "UTC")) ?? [],
    "Midnight Drive mix": async () => (await nightMixTracks({ fallbackRecipe: "midnight-drive", ranking: "drive" }, USER, TODAY, "UTC")) ?? [],
    "Minor Key Mondays mix": () => mixSongs(generateMinorKeyMix(USER, TODAY)),
    "a similar artist's station": () => station("artist", `${FILLERS[0]}-ar`),
    ...Object.fromEntries(STATION_TYPES.map(([type, value]) => [`the ${type} station`, () => station(type, value)])),
    "the Late Night station's cold start, filled with songs like a listener's one night song": async () =>
        (await nightStationPool(NIGHT, "UTC", "late-night")).map((s) => s.id),
    "similar songs": async () => {
        const features = jest.spyOn(featureDetection, "getFeatures").mockResolvedValue({ vibeEmbeddings: true } as never);
        try {
            return (await findSimilarTracks(NEAR, 100)).map((t) => t.id);
        } finally {
            features.mockRestore();
        }
    },
    "the matching's ranked matches": async () => {
        const { ctx, inputs } = await matching();
        return (await rankMatches(ctx, inputs, { limit: 100, counted: [] })).map((t) => t.id);
    },
    "the matching's top scores": async () => {
        const { ctx, inputs } = await matching();
        return (await topScores(ctx, inputs, 100)).map((t) => t.id);
    },
    "the matching's scores over the library": async () => {
        const { ctx, inputs } = await matching();
        return (await scoreLibrary(ctx, [inputs], [])).map((t) => t.id);
    },
    "a song path": async () => (await generateSongPath(NEAR, `${FILLERS[1]}-s1`, { length: 50 })).path.map((t) => t.id),
    "text search's ranking by sound": async () => (await searchTracksByEmbedding(soundOf(SONG.playable, 0), 100)).map((t) => t.id),
    "the songs the map lays out": async () =>
        (await prisma.$queryRaw<{ id: string }[]>`SELECT track_id AS id FROM matching_map WHERE track_id LIKE ${`${P}%`}`).map((r) => r.id),
    "the public vibe site's library export, with a map place left over for each unplayable song": async () => {
        await prisma.$executeRaw`
            INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out)
            SELECT track_id, analyzed_at, 0.1, 0.2, 0.3, 0.5, true FROM track_embeddings WHERE track_id = ANY(${UNPLAYABLE})
            ON CONFLICT DO NOTHING`;
        try {
            const doc = JSON.parse(zlib.gunzipSync((await refreshLibraryExport()).gzipped).toString());
            return doc.tracks.map((t: { id: string }) => t.id);
        } finally {
            await prisma.$executeRaw`DELETE FROM matching_map WHERE track_id = ANY(${UNPLAYABLE})`;
        }
    },
    "the vibe map": async () => {
        const map = await getVibeMap();
        if (map.status !== "ready") throw new Error(`the map is ${map.status}`);
        return map.data.tracks.map((t) => t.id);
    },
    "the map's mood summary, which lists only albums with a playable song": async () => {
        const summary = await getMoodSummary();
        if (summary.status !== "ready") throw new Error(`the mood summary is ${summary.status}`);
        return songsOfAlbums(Object.keys(summary.data.albums).map((id) => ({ id })));
    },
    "the mood snapshot": async () => {
        await refreshMoodSnapshot();
        return [...(await currentMoodSnapshot()).views.keys()];
    },
    "mood tags": async () => {
        await writeMoodTags();
        try {
            return (await prisma.track.findMany({ where: { id: { startsWith: P }, NOT: { moodTags: { isEmpty: true } } }, select: { id: true } })).map((t) => t.id);
        } finally {
            // Wildcard plays the untagged songs.
            await prisma.track.updateMany({ where: { id: { startsWith: P } }, data: { moodTags: [] } });
        }
    },
    "web song search": async () => (await searchService.searchTracks({ query: "playable", limit: 500 })).map((t) => t.id),
    "web song search by a name full-text search cannot read": async () =>
        (await searchService.searchTracks({ query: P, limit: 500 })).map((t) => t.id),
    "the stats page's never-played slice": () => slice("never", listenerOf("playable")),
    "the stats page's decade slice": () => slice("decade", USER, { decade: 1900 }),
    "the stats page's top slice": () => slice("top"),
    "the stats page's core slice": () => slice("core"),
    "the stats page's key slice": () => slice("key", USER, { key: `${KEY} minor` }),
    "the web song list": async () => (await web("/api/library/tracks?limit=10000")).tracks.map((t: { id: string }) => t.id),
    "the web song list of each seeded album": async () =>
        (await Promise.all(Object.values(SONG).map((id) => web(`/api/library/tracks?albumId=${id}-al`)))).flatMap((r) =>
            r.tracks.map((t: { id: string }) => t.id),
        ),
    "the web shuffle": async () => (await web("/api/library/tracks/shuffle?limit=10000")).tracks.map((t: { id: string }) => t.id),
    "the web artist page's play queue": async () => (await web(`/api/library/artists/${P}-ar/play-tracks`)).tracks.map((t: { id: string }) => t.id),
    ...Object.fromEntries(
        ["owned", "all"].map((filter) => [
            `the web album list showing ${filter}, which lists only albums with a playable song`,
            async () => songsOfAlbums((await web(`/api/library/albums?filter=${filter}&artistId=${P}-ar&limit=500`)).albums),
        ]),
    ),
    "the web artist page, which lists only albums with a playable song": async () => songsOfAlbums((await artistPage([])).albums),
    "web album search, which lists only albums with a playable song": async () =>
        songsOfAlbums(await searchService.searchAlbums({ query: "playable", limit: 500 })),
    "web album search by a name full-text search cannot read, which lists only albums with a playable song": async () =>
        songsOfAlbums(await searchService.searchAlbums({ query: P, limit: 500 })),
    "the web artist page's album songs": async () =>
        (await artistPage([])).albums.flatMap((a: { tracks: { id: string }[] }) => a.tracks.map((t) => t.id)),
    // The page matches a top-list title to an owned song by its part before any dash, and every seeded title starts
    // "zz-playable", so each of the four names whichever seeded song the page holds: it must hold only the playable one.
    "the web artist page's popular songs from a global top list": () => popularSongs(Object.keys(SONG).map((kind) => `${P} ${kind}`)),
    "the web artist page's popular songs from the listener's own plays": () => popularSongs([]),
    "the web artist page's popular songs for a listener with no plays": () => popularSongs([], listenerOf("playable")),
    "Subsonic getLyrics by artist and title": async () => {
        const found = await Promise.all(
            Object.entries(SONG).map(async ([kind, id]) =>
                (await reply("getLyrics.view", { artist: P, title: `${P} ${kind}` })).lyrics.title ? [id] : [],
            ),
        );
        return found.flat();
    },
    "the import preview, matching a source song by artist and title": () =>
        previewMatches(
            spotifyImportService.generatePreviewFromDeezer({
                id: "d", title: "d", tracks: KINDS.map((kind) => ({ deezerId: kind, title: titleOf(kind), artist: P, album: "x" })),
            }),
        ),
    // The source's artist is nobody in the library, so only the song's ISRC can lead to it.
    "the import preview, matching a source song by its ISRC": async () => {
        const fetched = jest.spyOn(spotifyService, "getPlaylist").mockResolvedValue({
            id: "sp", name: "sp", description: null, owner: "o", imageUrl: null, trackCount: KINDS.length,
            tracks: KINDS.map((kind) => sourceTrack({ title: titleOf(kind), isrc: `${SONG[kind as keyof typeof SONG]}-isrc` })),
        } as never);
        try {
            return await previewMatches(spotifyImportService.generatePreview("https://open.spotify.com/playlist/x"));
        } finally {
            fetched.mockRestore();
        }
    },
    "the import preview, matching a source song by an artist's first word": () =>
        previewMatches(
            spotifyImportService.generatePreviewFromDeezer({
                id: "d", title: "d", tracks: KINDS.map((kind) => ({ deezerId: kind, title: titleOf(kind), artist: `${P} and friends`, album: "x" })),
            }),
        ),
    "the import's playlist build, matching by artist and title": () =>
        importBuilt(KINDS.map((kind) => pendingOf({ artist: P, title: titleOf(kind) }))),
    "the import's playlist build, keeping a song the preview matched": () =>
        importBuilt(Object.values(SONG).map((id) => pendingOf({ preMatchedTrackId: id }))),
    "the import's playlist build, matching by ISRC": () =>
        importBuilt(Object.values(SONG).map((id) => pendingOf({ isrc: `${id}-isrc` }))),
    "the import's playlist build, matching by title alone": () =>
        importBuilt(KINDS.map((kind) => pendingOf({ title: titleOf(kind) }))),
    "the import's refresh after a download": () => importRefreshed(KINDS.map((kind) => pendingOf({ artist: P, title: titleOf(kind) }))),
    "the reconcile of waiting songs, matching by artist and title": () =>
        importReconciled(KINDS.map((kind) => ({ artist: P, title: titleOf(kind) }))),
    "the reconcile of waiting songs, matching by title alone": () =>
        importReconciled(KINDS.map((kind) => ({ artist: NOBODY, title: titleOf(kind) }))),
    "the M3U import, matching a file by its path": () => m3uMatches(KINDS.map((kind) => ({ filePath: `${P}/${kind}.flac` }))),
    "the M3U import, matching a file by its name": () => m3uMatches(KINDS.map((kind) => ({ filePath: `/elsewhere/${kind}.flac` }))),
    "the M3U import, matching a line by its artist and title": () =>
        m3uMatches(KINDS.map((kind) => ({ filePath: "/nowhere/n.flac", artist: P, title: titleOf(kind) }))),
    "the M3U import, matching a line by a similar artist and title": () =>
        m3uMatches(KINDS.map((kind) => ({ filePath: "/nowhere/n.flac", artist: P, title: `${titleOf(kind)} live` }))),
};

type Answer = { status: number; body: Buffer };
const subsonicBody = (res: Answer) => JSON.parse(res.body.toString())["subsonic-response"];
const sendsTheFile = (res: Answer) => expect(res.body.equals(BYTES)).toBe(true);

/** Every Subsonic route that plays or shows one song by id, and what it answers for a playable song. */
const STREAMS: Record<string, { ask: (id: string) => request.Test; plays: (res: Answer) => void }> = {
    "stream.view": { ask: (id) => subsonic("stream.view", { id }), plays: sendsTheFile },
    "download.view": { ask: (id) => subsonic("download.view", { id }), plays: sendsTheFile },
    "getTranscodeStream.view": {
        ask: (id) => subsonic("getTranscodeStream.view", { mediaId: id, mediaType: "song", transcodeParams: "q-original" }),
        plays: sendsTheFile,
    },
    "getTranscodeDecision.view": {
        ask: (id) => subsonic("getTranscodeDecision.view", { mediaId: id, mediaType: "song" }),
        plays: (res) => expect(subsonicBody(res).transcodeDecision.canDirectPlay).toBe(true),
    },
    "getSong.view": {
        ask: (id) => subsonic("getSong.view", { id }),
        plays: (res) => expect(subsonicBody(res).song.id).toBe(SONG.playable),
    },
    "getLyricsBySongId.view": {
        ask: (id) => subsonic("getLyricsBySongId.view", { id }),
        plays: (res) => expect(subsonicBody(res).lyricsList.structuredLyrics).toBeDefined(),
    },
};

async function cleanup() {
    // The statistics and the map are the whole library's; this file's songs are the library while it runs.
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
    for (const table of ["matching_map", "matching_feel", "track_moods", "track_embeddings"]) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE track_id LIKE $1`, `${P}%`);
    }
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.genre.deleteMany({ where: { name: GENRE } });
}

/** A night hour yesterday (UTC), so a seeded play is a recent night listen: night, familiar and similar-artist picks read it. */
const LISTENED = (() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 23));
})();

/**
 * A library artist and its albums as the app writes them: the name folded as the scanner folds it, the seeded genre, the
 * seeded year, a library album per song unless it says otherwise. Every derived field a picker filters on is filled, so
 * no filter passes on an empty default. Each song is played (a finished listen) and liked by USER.
 */
async function seedArtist(artist: { id: string; name: string; genre?: string; year?: number }, albums: { id: string; location?: "LIBRARY" | "DISCOVER"; cover?: string; songs: { id: string; title: string; filePath: string; missingSince?: Date | null; corrupt?: boolean; arousal?: number }[] }[]) {
    await prisma.artist.create({
        data: { id: artist.id, name: artist.name, normalizedName: normalizeArtistName(artist.name), identityKey: artistIdentityKey(artist.name), libraryAlbumCount: albums.length, genres: [artist.genre ?? GENRE] },
    });
    const genre = await prisma.genre.upsert({ where: { name: artist.genre ?? GENRE }, create: { name: artist.genre ?? GENRE }, update: {} });
    for (const album of albums) {
        await prisma.album.create({
            data: {
                id: album.id,
                rgMbid: `${album.id}-rg`,
                identityKey: `${album.id}-ak`,
                artistId: artist.id,
                title: album.songs[0].title,
                primaryType: "Album",
                year: artist.year ?? YEAR,
                originalYear: artist.year ?? YEAR,
                coverUrl: album.cover ?? null,
                location: album.location ?? "LIBRARY",
            },
        });
        if ((album.location ?? "LIBRARY") === "LIBRARY") {
            await prisma.ownedAlbum.create({ data: { artistId: artist.id, rgMbid: `${album.id}-rg`, source: "test" } });
        }
        for (const [i, song] of album.songs.entries()) {
            await prisma.track.create({
                data: {
                    id: song.id,
                    albumId: album.id,
                    title: song.title,
                    trackNo: i + 1,
                    duration: 100,
                    mime: "audio/flac",
                    filePath: song.filePath,
                    isrc: `${song.id}-isrc`,
                    fileModified: new Date(),
                    fileSize: BYTES.length,
                    missingSince: song.missingSince ?? null,
                    corrupt: song.corrupt ?? false,
                    trackGenres: { create: { genreId: genre.id } },
                    // One analysis for every song, so a picker that keeps "the upper half" or "minor key" keeps them all.
                    analysisStatus: "completed",
                    arousal: song.arousal ?? 0.5,
                    key: KEY,
                    keyScale: "minor",
                    bpm: 120,
                    energy: 0.5,
                    valence: 0.5,
                    danceability: 0.5,
                    instrumentalness: 0.5,
                },
            });
            await prisma.play.create({ data: { userId: USER, trackId: song.id, playedAt: LISTENED, heard: true } });
            await prisma.likedTrack.create({ data: { userId: USER, trackId: song.id } });
        }
    }
}

/**
 * Every seeded song's sound vector and mood scores, as the analysis and the mood step write them, then the similarity
 * step's statistics, the mood statistics and the map, built from the library as it is.
 */
async function seedSoundAndMoods() {
    const ids = (await prisma.track.findMany({ where: { id: { startsWith: P } }, select: { id: true }, orderBy: { id: "asc" } })).map((t) => t.id);
    for (const [i, id] of ids.entries()) {
        await prisma.$executeRaw`
            INSERT INTO track_embeddings (track_id, embedding, model_version)
            VALUES (${id}, ${`[${soundOf(id, i).join(",")}]`}::vector, ${MATCHING_MODEL})`;
        const moods = SEEDED.has(id) ? ENERGETIC : {};
        // Copied in SQL: the vector's time has microseconds a JavaScript Date would drop.
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_moods (track_id, embedded_at, weights, ${MOODS.map((m) => `"${m}"`).join(", ")})
             SELECT track_id, analyzed_at, $2, ${MOODS.map((_, k) => `$${k + 3}::real`).join(", ")}
             FROM track_embeddings WHERE track_id = $1`,
            id, MOOD_HEADS.version, ...MOODS.map((m) => moods[m] ?? 0),
        );
    }
    await buildMatching();
    await prisma.$transaction((tx) => buildMoodState(tx));
    await updateMap(true);
}

/** The cover of a seeded song's album (a filler's song too), so a station's cover is the cover of whichever playable song it picked. */
const coverOf = (id: string) => `${id}-cover`;

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    // The seeded songs, each alone on its album.
    await seedArtist(
        { id: `${P}-ar`, name: P },
        Object.entries(SONG).map(([kind, id]) => ({
            id: `${id}-al`,
            location: id === SONG.discover ? ("DISCOVER" as const) : ("LIBRARY" as const),
            cover: coverOf(id),
            songs: [{ id, title: `${P} ${kind}`, filePath: `${P}/${kind}.flac`, missingSince: id === SONG.missing ? new Date() : null, corrupt: id === SONG.corrupt, arousal: 0.9 }],
        })),
    );
    // Other library artists, two playable songs each, so every mix and station has enough to be made. With the
    // playable song, 19 songs by 10 artists: fewer than a mix holds, so a mix made holds the playable song.
    for (const id of FILLERS) {
        await seedArtist({ id: `${id}-ar`, name: `${P} ${id.slice(P.length + 1)}` }, [
            { id: `${id}-al`, cover: coverOf(`${id}-al`), songs: [1, 2].map((n) => ({ id: `${id}-s${n}`, title: `${P} ${id} ${n}`, filePath: `${P}/${id}-${n}.flac` })) },
        ]);
    }
    // The first filler's artist radio fills its similar share from the seeded songs' artist.
    await prisma.similarArtist.create({ data: { fromArtistId: `${FILLERS[0]}-ar`, toArtistId: `${P}-ar` } });
    for (const [kind, id] of Object.entries(SONG)) {
        // Each file is on disk, so a refusal can only come from the rule, never from a file the stream could not open.
        const file = path.join(config.music.musicPath, `${P}/${kind}.flac`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, BYTES);
        await prisma.subsonicBookmark.create({ data: { userId: USER, trackId: id, position: 1000 } });
        await prisma.trackLyrics.create({ data: { track_id: id, plain_lyrics: `${kind} words`, synced_lyrics: `[00:01.00]${kind} words`, source: "test" } });
        await prisma.user.create({
            data: {
                id: listenerOf(kind),
                username: listenerOf(kind),
                passwordHash: "x",
                role: "user",
                tokenVersion: 0,
                playbackState: { create: { playbackType: "track", trackId: id } },
            },
        });
    }
    const ids = Object.values(SONG);
    await prisma.playlist.create({
        data: {
            id: PLAYLIST,
            userId: USER,
            name: PLAYLIST,
            items: { create: ids.map((trackId, i) => ({ trackId, sort: i, rank: `a${i}` })) },
        },
    });
    await seedSoundAndMoods();
    await prisma.user.create({ data: { id: NIGHT, username: NIGHT, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.play.create({ data: { userId: NIGHT, trackId: `${FILLERS[0]}-s1`, playedAt: LISTENED, heard: true } });
    // A saved queue holding all four, the playable song current and last, so the ones before it are left out around it.
    await subsonic("savePlayQueue.view", { id: [...UNPLAYABLE, SONG.playable], current: SONG.playable }).expect(200);
});

afterAll(async () => {
    await cleanup();
    fs.rmSync(path.dirname(config.music.musicPath), { recursive: true, force: true });
});

describe.each(Object.entries(PICKERS))("%s", (_name, pick) => {
    it("offers the playable song and none of the Discover, missing or corrupt ones", async () => {
        const ids = await pick();
        expect(ids).toContain(SONG.playable);
        expect(ids.filter((id) => UNPLAYABLE.includes(id))).toEqual([]);
    });
});

// A station's cover is the album of the first song it would play that has one. Every seeded album has a cover, so a cover
// that is an unplayable song's album could only come from a station that picked that song. The station shuffles, so each is
// asked afresh 25 times.
describe.each(STATION_TYPES.filter(([type]) => type !== "artist"))("the %s station's cover (%s)", (type, value) => {
    const unplayable = UNPLAYABLE.map(coverOf);
    const playable = [coverOf(SONG.playable), ...FILLERS.map((id) => coverOf(`${id}-al`))];

    it("is the album of a playable song, never of a Discover, missing or corrupt one", async () => {
        for (let ask = 0; ask < 25; ask++) {
            const cover = await stationCover(type as CoverStationType, value);
            expect(cover).not.toBeNull();
            expect(unplayable).not.toContain(cover);
            expect(playable).toContain(cover);
        }
    });
});

describe("Discover Weekly's song lookup", () => {
    const lookup = (c: object): Promise<string[]> =>
        (discoverWeeklyService as any).discoverAlbumTracks(c).then((songs: { id: string }[]) => songs.map((s) => s.id));

    it("offers the Discover song, by release-group id and by artist and title", async () => {
        expect(await lookup({ albumMbid: `${SONG.discover}-al-rg` })).toEqual([SONG.discover]);
        expect(await lookup({ artistName: P, albumTitle: titleOf("discover") })).toEqual([SONG.discover]);
    });

    it.each(["playable", "missing", "corrupt"])("never offers the %s song, which is on a library album", async (kind) => {
        expect(await lookup({ albumMbid: `${SONG[kind as keyof typeof SONG]}-al-rg` })).toEqual([]);
        expect(await lookup({ artistName: P, albumTitle: titleOf(kind) })).toEqual([]);
    });
});

describe.each(Object.entries(STREAMS))("Subsonic %s", (_name, { ask, plays }) => {
    const answer = (id: string): Promise<Answer> =>
        ask(id).buffer(true).parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

    it("plays the playable song", async () => {
        const res = await answer(SONG.playable);
        expect(res.status).toBe(200);
        plays(res);
    });

    it.each([...Object.entries(SONG).filter(([kind]) => kind !== "playable"), ["unknown", `${P}-unknown`]])("answers not-found for the %s song", async (_kind, id) => {
        const res = await answer(id);
        expect(res.status).toBe(200);
        expect(subsonicBody(res)).toMatchObject({ status: "failed", error: { code: 70 } });
    });
});

// 19 playable songs in the seeded genre and decade; the Discover, missing and corrupt songs carry both too.
it("counts only playable songs for the radio row's genre and decade stations", async () => {
    expect((await libraryGenres()).find((g) => g.genre === GENRE)?.count).toBe(19);
    expect((await libraryDecades()).find((d) => d.decade === 1900)?.count).toBe(19);
});

// A genre and a decade need 15 songs to be a station. This artist has 19 songs in its own genre and decade (the seeded
// ones are 1900s), but only 10 play: with the unplayable ones counted it would be a station, so it is left out of the row.
describe("a genre and a decade whose playable songs fall short of the radio row's threshold", () => {
    const THIN_GENRE = `${P}-thin-genre`;
    const THIN_YEAR = 1801;
    const unplayableSong = (kind: string, n: number) => ({
        id: `${P}-thin-${kind}-${n}`, title: `${P} thin ${kind} ${n}`, filePath: `${P}/thin-${kind}-${n}.flac`,
        ...(kind === "missing" && { missingSince: new Date() }), ...(kind === "corrupt" && { corrupt: true }),
    });
    const songs = (kind: string, count: number) => Array.from({ length: count }, (_, n) => unplayableSong(kind, n));

    beforeAll(async () => {
        await seedArtist({ id: `${P}-thin-ar`, name: `${P} thin`, genre: THIN_GENRE, year: THIN_YEAR }, [
            { id: `${P}-thin-al`, songs: [...songs("ok", 10), ...songs("missing", 3), ...songs("corrupt", 3)] },
            { id: `${P}-thin-discover-al`, location: "DISCOVER", songs: songs("discover", 3) },
        ]);
    });
    afterAll(async () => {
        await prisma.track.deleteMany({ where: { id: { startsWith: `${P}-thin` } } });
        await prisma.album.deleteMany({ where: { id: { startsWith: `${P}-thin` } } });
        await prisma.artist.deleteMany({ where: { id: { startsWith: `${P}-thin` } } });
        await prisma.genre.deleteMany({ where: { name: THIN_GENRE } });
    });

    it("holds 19 songs in all, 10 of them playable", async () => {
        const where = { id: { startsWith: `${P}-thin` } };
        expect(await prisma.track.count({ where })).toBe(19);
        expect(await prisma.track.count({ where: { ...where, ...PLAYABLE_SONG } })).toBe(10);
    });

    it("is neither a genre nor a decade station", async () => {
        expect((await libraryGenres()).map((g) => g.genre)).not.toContain(THIN_GENRE);
        expect((await libraryDecades()).map((d) => d.decade)).not.toContain(1800);
    });

    it("is left out of the row itself", async () => {
        const features = jest.spyOn(featureDetection, "getFeatures").mockResolvedValue({ vibeEmbeddings: true } as never);
        try {
            const stations = await radioRow(USER, "UTC", "all");
            expect(stations.some((s) => s.type === "genre" && s.value === THIN_GENRE)).toBe(false);
            expect(stations.some((s) => s.type === "decade" && s.value === "1800")).toBe(false);
            // The seeded genre and decade, 19 playable songs each, are in it.
            expect(stations.find((s) => s.type === "genre" && s.value === GENRE)?.count).toBe(19);
            expect(stations.find((s) => s.type === "decade" && s.value === "1900")?.count).toBe(19);
        } finally {
            features.mockRestore();
            await redisClient.del(`radiocover:tz:${USER}`);
        }
    });
});

// The stats page's figures are counted over the whole library; the seeded songs are most of it.
it("counts only playable songs on the stats page's shelf", async () => {
    const playable = (extra: Prisma.TrackWhereInput = {}) => prisma.track.count({ where: { ...PLAYABLE_SONG, ...extra } });
    const albumsWithPlayable = (extra: Prisma.AlbumWhereInput = {}) => prisma.album.count({ where: { ...extra, tracks: { some: PLAYABLE_SONG } } });
    const unheard = await shelfStats(listenerOf("playable"));
    expect(unheard.tracks.total).toBe(await playable());
    expect(unheard.neverPlayed).toBe(unheard.tracks.total);
    expect(unheard.albums.total).toBe(await albumsWithPlayable());
    expect(unheard.artists.total).toBe(await prisma.artist.count({ where: { albums: { some: { tracks: { some: PLAYABLE_SONG } } } } }));
    const heard = await shelfStats(USER);
    expect(heard.tracks.heard).toBe(await playable({ plays: { some: { userId: USER } } }));
    expect(heard.albums.heard).toBe(await albumsWithPlayable({ tracks: { some: { ...PLAYABLE_SONG, plays: { some: { userId: USER } } } } }));
    // The decade strip leaves out the years before 1910, so the seeded albums move to the 1990s while it is read.
    const seeded = { id: { startsWith: P } };
    await prisma.album.updateMany({ where: seeded, data: { year: 1991 } });
    try {
        const nineties = (await shelfStats(USER)).decades.find((d) => d.decade === 1990);
        expect(nineties?.albums).toBe(await albumsWithPlayable({ year: { gte: 1990, lte: 1999 }, displayYear: null }));
    } finally {
        await prisma.album.updateMany({ where: seeded, data: { year: YEAR } });
    }
});

it("measures the shelf's sound in the stats page's signature from playable songs only", async () => {
    // The three unplayable songs turned all the way up, so counted they would pull the shelf's averages up.
    await prisma.track.updateMany({ where: { id: { in: UNPLAYABLE } }, data: { energy: 1, valence: 1, bpm: 300, instrumentalness: 1 } });
    try {
        const owned = Object.fromEntries((await signature(USER)).ownedVsPlayed.map((r) => [r.label, r.owned]));
        const shelf = await prisma.track.aggregate({
            where: { ...PLAYABLE_SONG, energy: { not: null } },
            _avg: { energy: true, valence: true, bpm: true, instrumentalness: true },
        });
        expect(owned.energy).toBeCloseTo(shelf._avg.energy!, 6);
        expect(owned.brightness).toBeCloseTo(shelf._avg.valence!, 6);
        expect(owned.bpm).toBeCloseTo(shelf._avg.bpm!, 6);
        expect(owned.instrumental).toBeCloseTo(shelf._avg.instrumentalness!, 6);
    } finally {
        await prisma.track.updateMany({ where: { id: { in: UNPLAYABLE } }, data: { energy: 0.5, valence: 0.5, bpm: 120, instrumentalness: 0.5 } });
    }
});

it("recommends artists from plays of playable songs only", async () => {
    const listener = `${P}-recs`;
    const stranger = `${P}-stranger-ar`;
    await prisma.artist.create({ data: { id: stranger, name: `${P} stranger`, normalizedName: normalizeArtistName(`${P} stranger`), identityKey: stranger } });
    await prisma.similarArtist.create({ data: { fromArtistId: `${P}-ar`, toArtistId: stranger } });
    await prisma.user.create({ data: { id: listener, username: listener, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.play.createMany({ data: UNPLAYABLE.map((trackId) => ({ userId: listener, trackId, playedAt: LISTENED, heard: true })) });
    expect((await web("/api/recommendations/for-you", listener)).artists).toEqual([]);
    await prisma.play.create({ data: { userId: listener, trackId: SONG.playable, playedAt: LISTENED, heard: true } });
    expect((await web("/api/recommendations/for-you", listener)).artists.map((a: { id: string }) => a.id)).toEqual([stranger]);
});

// An artist whose every song is missing still has a radio: the similar artists' share.
it("plays similar artists on the radio of an artist with no playable song", async () => {
    await seedArtist({ id: `${P}-gone-ar`, name: `${P} gone` }, [
        { id: `${P}-gone-al`, songs: [{ id: `${P}-gone-s1`, title: `${P} gone 1`, filePath: `${P}/gone-1.flac`, missingSince: new Date() }] },
    ]);
    await prisma.similarArtist.create({ data: { fromArtistId: `${P}-gone-ar`, toArtistId: `${FILLERS[1]}-ar` } });
    // Its similar artist, and the artists sharing its genre that make up a short list.
    expect(await station("artist", `${P}-gone-ar`)).toEqual(expect.arrayContaining([`${FILLERS[1]}-s1`, `${FILLERS[1]}-s2`]));
});

it("builds an artist's sound profile from its playable songs only", async () => {
    const state = await loadMatchingState();
    if (!state) throw new Error("no matching state");
    const profile = (await artistProfiles(state, [`${P}-ar`])).get(`${P}-ar`);
    const own = soundOf(SONG.playable, 0);
    const length = Math.hypot(...own);
    expect(Array.from(profile?.sound ?? [], (x) => Number(x.toFixed(5)))).toEqual(own.map((x) => Number((x / length).toFixed(5))));
});

it("refuses a table name that is not a plain identifier", () => {
    expect(() => playableSongSql(`t"; DROP TABLE "Track"; --`, "al")).toThrow();
});

it("refuses an album or artist name that is not an identifier, or that the pieces use inside", () => {
    for (const piece of [albumHasPlayableSongSql, artistHasPlayableSongSql]) {
        expect(() => piece(`a"; --`)).toThrow();
        expect(() => piece("ps")).toThrow();
        expect(() => piece("pa")).toThrow();
        expect(() => piece("al")).not.toThrow();
    }
});

// An artist whose library albums hold only a missing and a corrupt song has nothing to play, so it is listed nowhere
// artists are listed, and the seeded artist's album counts are its one album with a playable song.
describe("an artist with no playable song", () => {
    const VANISHED = `${P}-vanished-ar`;
    beforeAll(async () => {
        await seedArtist({ id: VANISHED, name: `${P} vanished` }, [
            { id: `${P}-vanished-al1`, songs: [{ id: `${P}-vanished-s1`, title: `${P} vanished 1`, filePath: `${P}/vanished-1.flac`, missingSince: new Date() }] },
            { id: `${P}-vanished-al2`, songs: [{ id: `${P}-vanished-s2`, title: `${P} vanished 2`, filePath: `${P}/vanished-2.flac`, corrupt: true }] },
        ]);
    });
    const listed = (ids: string[]) => {
        expect(ids).toContain(`${P}-ar`);
        expect(ids).not.toContain(VANISHED);
    };

    it("is not in the web artist list, whichever collection it shows", async () => {
        for (const filter of ["owned", "all"]) {
            listed((await web(`/api/library/artists?filter=${filter}&query=${P}&limit=500`)).artists.map((a: { id: string }) => a.id));
        }
    });

    it("is not found by web artist search", async () => {
        listed((await searchService.searchArtists({ query: "playable", limit: 500 })).map((a) => a.id));
        listed((await searchService.searchArtists({ query: P, limit: 500 })).map((a) => a.id));
    });

    it("is not among the recently added artists, and the seeded artist counts one album", async () => {
        const artists: { id: string; albumCount: number }[] = (await web("/api/library/recently-added?limit=100")).artists;
        listed(artists.map((a) => a.id));
        expect(artists.find((a) => a.id === `${P}-ar`)?.albumCount).toBe(1);
    });

    it("is a similar artist outside the library", async () => {
        // The one call off the server: neither seeded artist has an image of its own.
        const image = jest.spyOn(deezerService, "getArtistImage").mockResolvedValue(null);
        try {
            const similar = await resolveSimilarArtists([{ name: `${P} vanished`, match: 1 }, { name: P, match: 1 }]);
            expect(similar.map((a) => [a.inLibrary, a.ownedAlbumCount])).toEqual([[false, 0], [true, 1]]);
        } finally {
            image.mockRestore();
        }
    });

    it("is not among a genre's library artists", async () => {
        listed(await libraryArtistIdsForGenre(GENRE));
    });

    it("counts no albums and no songs, so the Subsonic artist lists leave it out", async () => {
        await updateArtistCounts(VANISHED);
        await updateArtistCounts(`${P}-ar`);
        const counts = await prisma.artist.findMany({
            where: { id: { in: [VANISHED, `${P}-ar`] } },
            select: { id: true, libraryAlbumCount: true, totalTrackCount: true },
            orderBy: { id: "asc" },
        });
        expect(counts).toEqual([
            { id: `${P}-ar`, libraryAlbumCount: 1, totalTrackCount: 1 },
            { id: VANISHED, libraryAlbumCount: 0, totalTrackCount: 0 },
        ]);
        const index = (await reply("getArtists.view", {})).artists.index ?? [];
        listed(index.flatMap((i: { artist: { id: string }[] }) => i.artist.map((a) => a.id)));
    });
});

// A playlist keeps listing a song that stopped playing, marked unavailable, and refuses to take one in.
describe("the web playlist", () => {
    const shown = (items: { track: { id: string }; unavailable: boolean }[]) =>
        Object.fromEntries(items.map((i) => [i.track.id, i.unavailable]));
    const expected = { [SONG.playable]: false, [SONG.discover]: true, [SONG.missing]: true, [SONG.corrupt]: true };

    it("lists every song it holds, marking the Discover, missing and corrupt ones unavailable", async () => {
        const playlist = await web(`/api/playlists/${PLAYLIST}`);
        expect(shown(playlist.items)).toEqual(expected);
        expect(shown(playlist.mergedItems)).toEqual(expected);
        expect(playlist.trackCount).toBe(4);
    });

    it("marks them in a reversed list too", async () => {
        const playlist = await web(`/api/playlists/${PLAYLIST}?order=rev`);
        expect(shown(playlist.items)).toEqual(expected);
    });

    it.each(UNPLAYABLE.map((id) => [id]))("refuses to take in %s", async (id) => {
        const target = await prisma.playlist.create({ data: { userId: USER, name: `${P}-add-${id}` } });
        const asked = (route: string, body: object) => request(app).post(`/api/playlists/${target.id}/${route}`).send(body);
        await asked("items", { trackId: id }).expect(404);
        const mixed = (await asked("items", { trackIds: [id, SONG.playable] }).expect(200)).body;
        expect(mixed).toMatchObject({ added: 1, rejected: [id] });
        const batch = (await asked("items/batch", { trackIds: [id, SONG.playable] }).expect(200)).body;
        expect(batch).toMatchObject({ added: 0, skippedExisting: 1, skippedInvalid: 1 });
        expect(batch.items.map((i: { trackId: string; unavailable: boolean }) => [i.trackId, i.unavailable])).toEqual([[SONG.playable, false]]);
        const held = await prisma.playlistItem.findMany({ where: { playlistId: target.id }, select: { trackId: true } });
        expect(held.map((i) => i.trackId)).toEqual([SONG.playable]);
    });

    it("marks the songs a batch add reads back, the ones it refused included when the playlist already holds them", async () => {
        const batch = (await request(app).post(`/api/playlists/${PLAYLIST}/items/batch`).send({ trackIds: Object.values(SONG) }).expect(200)).body;
        expect(batch).toMatchObject({ added: 0, skippedExisting: 1, skippedInvalid: 3 });
        expect(Object.fromEntries(batch.items.map((i: { trackId: string; unavailable: boolean }) => [i.trackId, i.unavailable]))).toEqual(expected);
    });
});

// What a Subsonic client does with the songs it was shown lines up with them, never with the ones left out. These run
// last: they rewrite the saved queue and the playlist the pickers read.
describe("the songs left out of a Subsonic list", () => {
    // A second playable song, so the song a queue moves to is told apart from the first playable one.
    const second = `${P}-second`;
    beforeAll(async () => {
        await prisma.album.create({
            data: { id: `${second}-al`, rgMbid: `${second}-rg`, identityKey: `${second}-ak`, artistId: `${P}-ar`, title: second, primaryType: "Album" },
        });
        await prisma.track.create({
            data: { id: second, albumId: `${second}-al`, title: second, trackNo: 1, duration: 50, filePath: `${P}/second.flac`, fileModified: new Date(), fileSize: 1 },
        });
    });

    it("move the play queue's current song with them, keeping its position", async () => {
        await subsonic("savePlayQueue.view", { id: [...UNPLAYABLE, SONG.playable], current: SONG.playable, position: "4200" }).expect(200);
        expect((await reply("getPlayQueue.view", {})).playQueue).toMatchObject({ current: SONG.playable, position: 4200 });
        expect((await reply("getPlayQueueByIndex.view", {})).playQueueByIndex).toMatchObject({ currentIndex: 0, position: 4200 });
    });

    it("hand a left-out current song on to the next playable one, from its start", async () => {
        await subsonic("savePlayQueue.view", { id: [second, SONG.missing, SONG.playable], current: SONG.missing, position: "4200" }).expect(200);
        expect((await reply("getPlayQueue.view", {})).playQueue).toMatchObject({ current: SONG.playable, position: 0 });
    });

    it("hand a left-out current song back to the last playable one when none follows", async () => {
        await subsonic("savePlayQueue.view", { id: [second, SONG.playable, SONG.corrupt], current: SONG.corrupt, position: "4200" }).expect(200);
        expect((await reply("getPlayQueueByIndex.view", {})).playQueueByIndex).toMatchObject({ currentIndex: 1, position: 0 });
        expect((await reply("getPlayQueue.view", {})).playQueue).toMatchObject({ current: SONG.playable });
    });

    it("count a playlist's songs as getPlaylist shows them", async () => {
        const listed = (await reply("getPlaylists.view", {})).playlists.playlist.find((p: { id: string }) => p.id === PLAYLIST);
        expect(listed).toMatchObject({ songCount: 1, duration: 100 });
    });

    it("are not counted by the index a client removes a song by", async () => {
        // Shown: only the playable song, at index 0, though the three left out sit before it in the playlist.
        await subsonic("updatePlaylist.view", { playlistId: PLAYLIST, songIndexToRemove: "0" }).expect(200);
        expect((await reply("getPlaylist.view", { id: PLAYLIST })).playlist.entry).toBeUndefined();
        const kept = await prisma.playlistItem.findMany({ where: { playlistId: PLAYLIST }, orderBy: { rank: "asc" }, select: { trackId: true } });
        expect(kept.map((i) => i.trackId)).toEqual(UNPLAYABLE);
    });

    it("start the song made current from its beginning when the client's current one was unknown", async () => {
        await subsonic("savePlayQueue.view", { id: [SONG.playable, `${P}-unknown`, second], current: `${P}-unknown`, position: "4200" }).expect(200);
        expect((await reply("getPlayQueue.view", {})).playQueue).toMatchObject({ current: second, position: 0 });
        await subsonic("savePlayQueueByIndex.view", { id: [SONG.playable, `${P}-unknown`, second], currentIndex: "1", position: "4200" }).expect(200);
        expect((await reply("getPlayQueueByIndex.view", {})).playQueueByIndex).toMatchObject({ currentIndex: 1, position: 0 });
    });

    it("point the saved current song at the queue as stored when an id was unknown", async () => {
        await subsonic("savePlayQueue.view", { id: [`${P}-unknown`, SONG.playable, second], current: SONG.playable }).expect(200);
        expect((await reply("getPlayQueue.view", {})).playQueue).toMatchObject({ current: SONG.playable });
        await subsonic("savePlayQueueByIndex.view", { id: [`${P}-unknown`, SONG.playable, second], currentIndex: "1" }).expect(200);
        expect((await reply("getPlayQueueByIndex.view", {})).playQueueByIndex).toMatchObject({ currentIndex: 0 });
        expect((await reply("getPlayQueue.view", {})).playQueue).toMatchObject({ current: SONG.playable });
    });

    it.each(UNPLAYABLE.map((id) => [id]))("cannot be added to a playlist or bookmarked: %s", async (id) => {
        const refused = { status: "failed", error: { code: 70 } };
        expect((await subsonic("createPlaylist.view", { name: `${P}-new`, songId: [SONG.playable, id] }).expect(200)).body["subsonic-response"]).toMatchObject(refused);
        expect((await subsonic("createPlaylist.view", { playlistId: PLAYLIST, songId: id }).expect(200)).body["subsonic-response"]).toMatchObject(refused);
        expect((await subsonic("updatePlaylist.view", { playlistId: PLAYLIST, songIdToAdd: id }).expect(200)).body["subsonic-response"]).toMatchObject(refused);
        expect((await subsonic("createBookmark.view", { id, position: "5" }).expect(200)).body["subsonic-response"]).toMatchObject(refused);
        expect(await prisma.playlist.count({ where: { userId: USER, name: `${P}-new` } })).toBe(0);
    });

    it("leave a scrobble answered but unrecorded, while a playable song's scrobble counts", async () => {
        const time = String(Date.UTC(2001, 0, 1));
        for (const id of [...UNPLAYABLE, SONG.playable]) {
            await subsonic("scrobble.view", { id, submission: "true", time }).expect(200);
        }
        const recorded = await prisma.play.findMany({ where: { userId: USER, playedAt: new Date(Number(time)) }, select: { trackId: true } });
        expect(recorded.map((p) => p.trackId)).toEqual([SONG.playable]);
    });

    it("leave a batch scrobble's unplayable songs unrecorded and record each playable one at its own time", async () => {
        const times = [Date.UTC(2002, 0, 1), Date.UTC(2002, 0, 2), Date.UTC(2002, 0, 3)];
        await subsonic("scrobble.view", { id: [SONG.playable, SONG.discover, second], time: times.map(String), submission: "true" }).expect(200);
        const recorded = await prisma.play.findMany({
            where: { userId: USER, playedAt: { in: times.map((t) => new Date(t)) } },
            orderBy: { playedAt: "asc" },
            select: { trackId: true, playedAt: true },
        });
        expect(recorded).toEqual([
            { trackId: SONG.playable, playedAt: new Date(times[0]) },
            { trackId: second, playedAt: new Date(times[2]) },
        ]);
    });

    it("answer a now-playing scrobble of an unplayable song ok", async () => {
        for (const id of UNPLAYABLE) {
            expect((await reply("scrobble.view", { id, submission: "false" })).status).toBe("ok");
        }
    });

    it("are not picked for lyrics by a title the database folds", async () => {
        // A non-ASCII title is matched in SQL, not by Prisma; the four songs get one, then their own back.
        for (const [kind, id] of Object.entries(SONG)) await prisma.track.update({ where: { id }, data: { title: `${P} ${kind} ü` } });
        try {
            for (const artist of [P, undefined]) {
                const found = [];
                for (const [kind, id] of Object.entries(SONG)) {
                    const lyrics = (await reply("getLyrics.view", { ...(artist ? { artist } : {}), title: `${P} ${kind} Ü` })).lyrics;
                    if (lyrics.title) found.push(id);
                }
                expect(found).toEqual([SONG.playable]);
            }
        } finally {
            for (const [kind, id] of Object.entries(SONG)) await prisma.track.update({ where: { id }, data: { title: `${P} ${kind}` } });
        }
    });

    it("are kept when a client replaces the playlist with the songs it was shown", async () => {
        await subsonic("createPlaylist.view", { playlistId: PLAYLIST, songId: [second, SONG.playable] }).expect(200);
        expect(idsOf((await reply("getPlaylist.view", { id: PLAYLIST })).playlist.entry)).toEqual([second, SONG.playable]);
        const kept = await prisma.playlistItem.findMany({ where: { playlistId: PLAYLIST }, orderBy: { rank: "asc" }, select: { trackId: true } });
        expect(kept.map((i) => i.trackId)).toEqual([second, SONG.playable, ...UNPLAYABLE]);
    });
});

// A Subsonic app is never offered an unplayable song, so starring or sharing one answers as for an id that is not there.
describe("Subsonic star and createShare", () => {
    const asNight = (route: string, query: Record<string, string | string[]>) =>
        request(app).get(`/rest/${route}`).set("x-user", NIGHT).query({ u: NIGHT, f: "json", ...query });

    it("stars the playable song and skips the Discover, missing and corrupt ones", async () => {
        const res = await asNight("star.view", { id: Object.values(SONG) }).expect(200);
        expect(res.body["subsonic-response"].status).toBe("ok");
        const liked = await prisma.likedTrack.findMany({ where: { userId: NIGHT }, select: { trackId: true } });
        expect(liked.map((l) => l.trackId)).toEqual([SONG.playable]);
    });

    it("rates only the playable song: a rating of a Discover, missing or corrupt one stores no like", async () => {
        await prisma.likedTrack.deleteMany({ where: { userId: NIGHT } });
        for (const id of Object.values(SONG)) {
            const res = await asNight("setRating.view", { id, rating: "5" }).expect(200);
            expect(res.body["subsonic-response"].status).toBe("ok");
        }
        const liked = await prisma.likedTrack.findMany({ where: { userId: NIGHT }, select: { trackId: true } });
        expect(liked.map((l) => l.trackId)).toEqual([SONG.playable]);
    });

    it.each([SONG.playable, `${SONG.playable}-al`])("shares %s, the playable song or its album", async (id) => {
        const res = await asNight("createShare.view", { id }).expect(200);
        expect(res.body["subsonic-response"].status).toBe("ok");
        expect(await prisma.shareLink.count({ where: { entityId: id, createdBy: NIGHT } })).toBe(1);
    });

    it.each(UNPLAYABLE.flatMap((id) => [id, `${id}-al`]))("answers not-found when asked to share %s", async (id) => {
        const res = await asNight("createShare.view", { id }).expect(200);
        expect(res.body["subsonic-response"]).toMatchObject({ status: "failed", error: { code: 70 } });
        expect(await prisma.shareLink.count({ where: { entityId: id } })).toBe(0);
    });
});

describe("Subsonic createShare", () => {
    const SHARER = `${P}-sharer`;
    const SHARER_LIST = `${P}-sharer-list`;
    const asSharer = (query: Record<string, string | string[]>) =>
        request(app).get("/rest/createShare.view").set("x-user", SHARER).query({ u: SHARER, f: "json", ...query });
    const create = async (query: Record<string, string | string[]>) => (await asSharer(query).expect(200)).body["subsonic-response"];
    const links = () => prisma.shareLink.findMany({ where: { createdBy: SHARER } });
    const shareOf = (body: { shares: { share: { id: string; entry?: { id: string }[] }[] } }) => body.shares.share[0];
    const FUTURE = Date.now() + 3 * 3600_000;

    beforeAll(async () => {
        await prisma.user.create({ data: { id: SHARER, username: SHARER, passwordHash: "x", role: "user", tokenVersion: 0 } });
        await prisma.playlist.create({
            data: {
                id: SHARER_LIST,
                userId: SHARER,
                name: SHARER_LIST,
                items: { create: [...Object.values(SONG), `${FILLERS[0]}-s1`].map((trackId, i) => ({ trackId, sort: i, rank: `a${i}` })) },
            },
        });
    });
    beforeEach(async () => {
        await prisma.shareLink.deleteMany({ where: { createdBy: SHARER } });
    });

    it("expires the link when `expires` says, in epoch milliseconds", async () => {
        const body = await create({ id: SONG.playable, expires: String(FUTURE) });
        expect(body.status).toBe("ok");
        const [link] = await links();
        expect(link.expiresAt?.getTime()).toBe(FUTURE);
        expect(shareOf(body)).toMatchObject({ id: link.token, expires: new Date(FUTURE).toISOString() });
    });

    it("never expires a link made with `expires` of 0, or with none", async () => {
        for (const query of [{ expires: "0" }, {}] as Record<string, string>[]) {
            await prisma.shareLink.deleteMany({ where: { createdBy: SHARER } });
            const body = await create({ id: SONG.playable, ...query });
            expect(body.status).toBe("ok");
            expect((await links())[0].expiresAt).toBeNull();
            expect(shareOf(body)).not.toHaveProperty("expires");
        }
    });

    it("refuses an `expires` that is not a number, as updateShare does, and makes no link", async () => {
        const body = await create({ id: SONG.playable, expires: "tomorrow" });
        expect(body).toMatchObject({ status: "failed", error: { code: 10 } });
        expect(await links()).toEqual([]);
    });

    it("refuses an `expires` too large to be a date, instead of failing with a server error", async () => {
        const body = await create({ id: SONG.playable, expires: "1e20" });
        expect(body).toMatchObject({ status: "failed", error: { code: 10 } });
        expect(await links()).toEqual([]);
    });

    it("leaves a reused link's expiry as it was", async () => {
        await create({ id: SONG.playable });
        const body = await create({ id: SONG.playable, expires: String(FUTURE) });
        expect(body.status).toBe("ok");
        const stored = await links();
        expect(stored).toHaveLength(1);
        expect(stored[0].expiresAt).toBeNull();
        expect(shareOf(body)).not.toHaveProperty("expires");
    });

    it("answers that a share holds one item when several ids come, and makes no link", async () => {
        const body = await create({ id: [SONG.playable, `${FILLERS[0]}-s1`] });
        expect(body).toMatchObject({ status: "failed", error: { code: 0, message: "a share holds one item" } });
        expect(await links()).toEqual([]);
    });

    it("carries the stored creation time and visit count, also when an existing link is reused", async () => {
        await create({ id: SONG.playable });
        const made = new Date(Date.now() - 5 * 86_400_000);
        await prisma.shareLink.updateMany({ where: { createdBy: SHARER }, data: { createdAt: made, playCount: 7 } });
        const body = await create({ id: SONG.playable });
        expect(await links()).toHaveLength(1);
        expect(shareOf(body)).toMatchObject({ created: made.toISOString(), visitCount: 7 });
    });

    it("does not echo a description, which is never stored", async () => {
        const body = await create({ id: SONG.playable, description: "for you" });
        expect(shareOf(body)).not.toHaveProperty("description");
    });

    it("lists a song share's song as its entry", async () => {
        const body = await create({ id: SONG.playable });
        expect(idsOf(shareOf(body).entry)).toEqual([SONG.playable]);
    });

    it("lists an album share's playable songs, in album order", async () => {
        const body = await create({ id: `${FILLERS[0]}-al` });
        const expected = await prisma.track.findMany({
            where: { albumId: `${FILLERS[0]}-al`, ...PLAYABLE_SONG },
            orderBy: [{ discNumber: { sort: "asc", nulls: "first" } }, { trackNo: "asc" }],
            select: { id: true },
        });
        expect(expected.length).toBeGreaterThan(1);
        expect(idsOf(shareOf(body).entry)).toEqual(expected.map((t) => t.id));
    });

    it("lists a playlist share's playable songs only, in playlist order", async () => {
        const body = await create({ id: SHARER_LIST });
        expect(body.status).toBe("ok");
        expect(idsOf(shareOf(body).entry)).toEqual([SONG.playable, `${FILLERS[0]}-s1`]);
    });

    describe("getShares", () => {
        const list = async () =>
            (await request(app).get("/rest/getShares.view").set("x-user", SHARER).query({ u: SHARER, f: "json" }).expect(200)).body["subsonic-response"];

        it("lists each share's playable songs as its entry, the same as createShare answered", async () => {
            const made: Record<string, { id: string; entry?: { id: string }[] }> = {};
            for (const id of [SONG.playable, `${FILLERS[0]}-al`, SHARER_LIST]) made[id] = shareOf(await create({ id }));
            expect(made[SONG.playable].entry).toHaveLength(1);
            expect(made[`${FILLERS[0]}-al`].entry!.length).toBeGreaterThan(1);

            const body = await list();
            expect(body.status).toBe("ok");
            expect(body.shares.share).toHaveLength(3);
            for (const share of body.shares.share) {
                const was = Object.values(made).find((m) => m.id === share.id)!;
                expect(share.entry).toEqual(was.entry);
            }
        });

        it("leaves the entry out of a share with nothing left to play", async () => {
            await create({ id: SONG.playable });
            await prisma.track.update({ where: { id: SONG.playable }, data: { corrupt: true } });
            try {
                const body = await list();
                expect(body.shares.share).toHaveLength(1);
                expect(body.shares.share[0]).not.toHaveProperty("entry");
            } finally {
                await prisma.track.update({ where: { id: SONG.playable }, data: { corrupt: false } });
            }
        });
    });
});

// Kima keeps song likes only, so starring an album or an artist answers an error rather than "ok" for a star never kept.
describe("Subsonic star and unstar", () => {
    const WHO = `${P}-starrer`;
    const asWho = (route: string, query: Record<string, string | string[]>) =>
        request(app).get(`/rest/${route}`).set("x-user", WHO).query({ u: WHO, f: "json", ...query });
    const answer = async (route: string, query: Record<string, string | string[]>) => (await asWho(route, query).expect(200)).body["subsonic-response"];
    const liked = async () => (await prisma.likedTrack.findMany({ where: { userId: WHO }, select: { trackId: true } })).map((l) => l.trackId).sort();
    const NOT_SUPPORTED = { status: "failed", error: { code: 0, message: "starring albums and artists isn't supported" } };
    const MISSING = { status: "failed", error: { code: 10 } };

    beforeAll(async () => {
        await prisma.user.create({ data: { id: WHO, username: WHO, passwordHash: "x", role: "user", tokenVersion: 0 } });
    });
    beforeEach(async () => {
        await prisma.likedTrack.deleteMany({ where: { userId: WHO } });
    });

    it.each(["star.view", "unstar.view"])("%s with no id, albumId or artistId answers a missing parameter", async (route) => {
        expect(await answer(route, {})).toMatchObject(MISSING);
    });

    it.each([["albumId", `${SONG.playable}-al`], ["artistId", `${P}-ar`]])("star with an %s answers not supported and stores nothing", async (param, id) => {
        expect(await answer("star.view", { [param]: id })).toMatchObject(NOT_SUPPORTED);
        expect(await liked()).toEqual([]);
    });

    it.each([["albumId", `${SONG.playable}-al`], ["artistId", `${P}-ar`]])("star with an %s and a song id stores no like for the song either", async (param, id) => {
        expect(await answer("star.view", { id: SONG.playable, [param]: id })).toMatchObject(NOT_SUPPORTED);
        expect(await liked()).toEqual([]);
    });

    it.each([["albumId", `${SONG.playable}-al`], ["artistId", `${P}-ar`]])("unstar with an %s answers not supported and removes no like", async (param, id) => {
        await prisma.likedTrack.create({ data: { userId: WHO, trackId: SONG.playable } });
        expect(await answer("unstar.view", { [param]: id })).toMatchObject(NOT_SUPPORTED);
        expect(await answer("unstar.view", { id: SONG.playable, [param]: id })).toMatchObject(NOT_SUPPORTED);
        expect(await liked()).toEqual([SONG.playable]);
    });

    it("stars song ids alone as before: playable ones stored once however often they are asked, the others skipped", async () => {
        const second = `${FILLERS[0]}-s1`;
        const third = `${FILLERS[0]}-s2`;
        expect((await answer("star.view", { id: [second, SONG.playable, ...UNPLAYABLE, `${P}-unknown`] })).status).toBe("ok");
        expect(await liked()).toEqual([second, SONG.playable].sort());
        // Asked again with one new song among the stored: nothing doubles, the new one is added.
        expect((await answer("star.view", { id: [SONG.playable, third, second, second] })).status).toBe("ok");
        expect(await liked()).toEqual([second, third, SONG.playable].sort());
        expect((await answer("unstar.view", { id: [second, third] })).status).toBe("ok");
        expect(await liked()).toEqual([SONG.playable]);
    });
});

// The More Like mix starts from the artist of a listener's recent plays; a play of a song that cannot play is no start.
it("starts the More Like mix from plays of playable songs only", async () => {
    const listener = `${P}-more-like`;
    await prisma.user.create({ data: { id: listener, username: listener, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artists = await prisma.artist.findMany({ where: { id: { startsWith: P } }, select: { name: true } });
    const similar = jest.spyOn(artistSimilarity, "getSimilarArtists").mockResolvedValue(artists.map((a) => ({ name: a.name })) as never);
    try {
        await prisma.play.createMany({ data: UNPLAYABLE.map((trackId) => ({ userId: listener, trackId, playedAt: LISTENED, heard: true })) });
        expect(await generateArtistSimilarMix(listener)).toBeNull();
        await prisma.play.create({ data: { userId: listener, trackId: SONG.playable, playedAt: LISTENED, heard: true } });
        const made = await mixSongs(generateArtistSimilarMix(listener));
        expect(made).toContain(SONG.playable);
        expect(made.filter((id) => UNPLAYABLE.includes(id))).toEqual([]);
    } finally {
        similar.mockRestore();
    }
});

// A missing file is flagged, never deleted: the song is back in every interface when the file returns, with no other work.
describe("a song whose missing file returns", () => {
    afterAll(async () => {
        await prisma.track.update({ where: { id: SONG.missing }, data: { missingSince: new Date() } });
        await buildMatching();
    });

    it("is offered again by the rule, the lists and the matching", async () => {
        const returning = ["the rule as a Prisma where piece", "the rule as a SQL fragment", "Subsonic search3 by title", "the web song list", "Subsonic getAlbum"];
        for (const name of returning) expect(await PICKERS[name]()).not.toContain(SONG.missing);
        await prisma.track.update({ where: { id: SONG.missing }, data: { missingSince: null } });
        // Playable again, so owed feel: the similarity step's next run gives it some.
        await buildMatching();
        for (const name of [...returning, "similar songs"]) expect(await PICKERS[name]()).toContain(SONG.missing);
    });
});
