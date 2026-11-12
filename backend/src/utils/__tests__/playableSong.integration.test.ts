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

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "../db";
import { normalizeArtistName } from "../../services/artistIdentity";
import { config } from "../../config";
import { PLAYABLE_SONG, playableSongSql } from "../libraryEligibility";
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

const P = "zz-playable";
const USER = `${P}-user`;
const SONG = { playable: `${P}-ok`, discover: `${P}-discover`, missing: `${P}-missing`, corrupt: `${P}-corrupt` } as const;
const UNPLAYABLE: string[] = [SONG.discover, SONG.missing, SONG.corrupt];
const BYTES = Buffer.from("fLaC-playable-song-bytes");
/** A year and a genre only the seeded songs carry, so a list narrowed by them holds only these. */
const YEAR = 1901;
const GENRE = `${P}-genre`;
const PLAYLIST = `${P}-playlist`;
/** The other library artists, each with one album of two playable songs. */
const FILLERS = Array.from({ length: 9 }, (_, i) => `${P}-f${i}`);
/** Someone else listening to one seeded song, so the now-playing list has each to offer. */
const listenerOf = (kind: string) => `${P}-listener-${kind}`;

const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/rest", compatRouter, playbackRouter, searchRouter, libraryRouter, starredRouter, playlistRouter, queueRouter, lyricsRouter);
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
const STATION_TYPES: [string, string | undefined][] = [["all", undefined], ["discovery", undefined], ["favorites", undefined], ["decade", "1900"], ["genre", GENRE], ["artist", `${P}-ar`]];
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
        STATION_TYPES.filter(([type]) => type !== "artist").map(([type, value]) => [`the ${type} station's cover`, () => stationCover(type as CoverStationType, value)]),
    ),
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
async function seedArtist(artist: { id: string; name: string }, albums: { id: string; location?: "LIBRARY" | "DISCOVER"; cover?: string; songs: { id: string; title: string; filePath: string; missingSince?: Date | null; corrupt?: boolean }[] }[]) {
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
                    arousal: 0.5,
                    keyScale: "minor",
                    bpm: 120,
                    energy: 0.5,
                    valence: 0.5,
                    danceability: 0.5,
                },
            });
            await prisma.play.create({ data: { userId: USER, trackId: song.id, playedAt: LISTENED, heard: true } });
            await prisma.likedTrack.create({ data: { userId: USER, trackId: song.id } });
        }
    }
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
            songs: [{ id, title: `${P} ${kind}`, filePath: `${P}/${kind}.flac`, missingSince: id === SONG.missing ? new Date() : null, corrupt: id === SONG.corrupt }],
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

// An artist whose every song is missing still has a radio: the similar artists' share.
it("plays similar artists on the radio of an artist with no playable song", async () => {
    await seedArtist({ id: `${P}-gone-ar`, name: `${P} gone` }, [
        { id: `${P}-gone-al`, songs: [{ id: `${P}-gone-s1`, title: `${P} gone 1`, filePath: `${P}/gone-1.flac`, missingSince: new Date() }] },
    ]);
    await prisma.similarArtist.create({ data: { fromArtistId: `${P}-gone-ar`, toArtistId: `${FILLERS[1]}-ar` } });
    // Its similar artist, and the artists sharing its genre that make up a short list.
    expect(await station("artist", `${P}-gone-ar`)).toEqual(expect.arrayContaining([`${FILLERS[1]}-s1`, `${FILLERS[1]}-s2`]));
});

it("refuses a table name that is not a plain identifier", () => {
    expect(() => playableSongSql(`t"; DROP TABLE "Track"; --`, "al")).toThrow();
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
