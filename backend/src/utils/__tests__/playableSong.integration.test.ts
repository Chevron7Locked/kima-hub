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
import { normalizeArtistName } from "../../services/artistIdentity";
import { config } from "../../config";
import { PLAYABLE_SONG, playableSongSql } from "../libraryEligibility";
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
import { libraryDecades, libraryGenres } from "../../services/mixes/radioRow";
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
import { updateArtistCounts } from "../../services/artistCountsService";
import { libraryArtistIdsForGenre } from "../genreSql";
import recommendationsRouter from "../../routes/recommendations";
import { deezerService } from "../../services/deezer";
import { dataCacheService } from "../../services/dataCache";

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
    .use((req: any, _res, next) => {
        // The web routes can be asked as another user, named in `x-user`.
        const id = req.get("x-user") ?? USER;
        req.user = { id, username: id, role: "user" };
        next();
    })
    .use("/rest", compatRouter, playbackRouter, searchRouter, libraryRouter, starredRouter, playlistRouter, queueRouter, lyricsRouter)
    .use("/api/library", libraryTracksRouter, libraryArtistsRouter, libraryAlbumsRouter)
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
/** The song whose album is USER's cover for a station today; only the seeded songs' albums have covers. */
async function stationCover(type: CoverStationType, value?: string): Promise<string[]> {
    const keys = await redisClient.keys(`radiocover:${USER}:*`);
    if (keys.length) await redisClient.del(...keys);
    const [cover] = await stationCovers([{ type, value }], USER, "UTC");
    return Object.values(SONG).filter((id) => coverOf(id) === cover);
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
        await redisClient.del(`similar-artists:${P}-ar`);
    }
}
const popularSongs = async (global: string[], user = USER): Promise<string[]> =>
    (await artistPage(global, user)).topTracks.map((t: { id: string }) => t.id);
const ALBUM_LIST_TYPES = ["newest", "alphabeticalByName", "alphabeticalByArtist", "byYear", "byGenre", "starred", "random", "recent", "frequent"];

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
    "Subsonic getTopSongs": async () => idsOf((await reply("getTopSongs.view", { artist: P, count: "500" })).topSongs.song),
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
    ...Object.fromEntries(
        STATION_TYPES.filter(([type]) => type !== "artist").map(([type, value]) => [
            `the ${value ?? type} station's cover`,
            () => stationCover(type as CoverStationType, value),
        ]),
    ),
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
async function seedArtist(artist: { id: string; name: string }, albums: { id: string; location?: "LIBRARY" | "DISCOVER"; cover?: string; songs: { id: string; title: string; filePath: string; missingSince?: Date | null; corrupt?: boolean; arousal?: number }[] }[]) {
    await prisma.artist.create({
        data: { id: artist.id, name: artist.name, normalizedName: normalizeArtistName(artist.name), identityKey: artist.id, libraryAlbumCount: albums.length, genres: [GENRE] },
    });
    const genre = await prisma.genre.upsert({ where: { name: GENRE }, create: { name: GENRE }, update: {} });
    for (const album of albums) {
        await prisma.album.create({
            data: {
                id: album.id,
                rgMbid: `${album.id}-rg`,
                identityKey: `${album.id}-ak`,
                artistId: artist.id,
                title: album.songs[0].title,
                primaryType: "Album",
                year: YEAR,
                originalYear: YEAR,
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

/** The cover of a seeded song's album; the fillers have none, so a station's cover can only be one of these. */
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
            { id: `${id}-al`, songs: [1, 2].map((n) => ({ id: `${id}-s${n}`, title: `${P} ${id} ${n}`, filePath: `${P}/${id}-${n}.flac` })) },
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
