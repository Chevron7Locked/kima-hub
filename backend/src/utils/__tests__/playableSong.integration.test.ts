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
import { config } from "../../config";
import { PLAYABLE_SONG, playableSongSql } from "../libraryEligibility";
import { compatRouter } from "../../routes/subsonic/compat";
import { playbackRouter } from "../../routes/subsonic/playback";
import { searchRouter } from "../../routes/subsonic/search";
import { libraryRouter } from "../../routes/subsonic/library";
import { starredRouter } from "../../routes/subsonic/starred";
import { playlistRouter } from "../../routes/subsonic/playlists";
import { queueRouter } from "../../routes/subsonic/queue";

const P = "zz-playable";
const USER = `${P}-user`;
const SONG = { playable: `${P}-ok`, discover: `${P}-discover`, missing: `${P}-missing`, corrupt: `${P}-corrupt` } as const;
const UNPLAYABLE: string[] = [SONG.discover, SONG.missing, SONG.corrupt];
const BYTES = Buffer.from("fLaC-playable-song-bytes");
/** A year and a genre only the seeded songs carry, so a list narrowed by them holds only these. */
const YEAR = 1901;
const GENRE = `${P}-genre`;
const PLAYLIST = `${P}-playlist`;

const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/rest", compatRouter, playbackRouter, searchRouter, libraryRouter, starredRouter, playlistRouter, queueRouter);
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
};

type Answer = { status: number; body: Buffer };
const subsonicBody = (res: Answer) => JSON.parse(res.body.toString())["subsonic-response"];
const sendsTheFile = (res: Answer) => expect(res.body.equals(BYTES)).toBe(true);

/** Every Subsonic route that plays one song by id, and what it answers for a playable song. */
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
};

async function cleanup() {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, identityKey: `${P}-ar`, libraryAlbumCount: 3, genres: [GENRE] } });
    for (const [kind, id] of Object.entries(SONG)) {
        // Each file is on disk, so a refusal can only come from the rule, never from a file the stream could not open.
        const rel = `${P}/${kind}.flac`;
        const file = path.join(config.music.musicPath, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, BYTES);
        await prisma.album.create({
            data: {
                id: `${id}-al`,
                rgMbid: `${id}-rg`,
                identityKey: `${id}-ak`,
                artistId: `${P}-ar`,
                title: `${P} ${kind}`,
                primaryType: "Album",
                year: YEAR,
                location: id === SONG.discover ? "DISCOVER" : "LIBRARY",
            },
        });
        await prisma.track.create({
            data: {
                id,
                albumId: `${id}-al`,
                title: `${P} ${kind}`,
                trackNo: 1,
                duration: 100,
                mime: "audio/flac",
                filePath: rel,
                fileModified: new Date(),
                fileSize: BYTES.length,
                missingSince: id === SONG.missing ? new Date() : null,
                corrupt: id === SONG.corrupt,
            },
        });
        // Played and liked, so the lists of starred, recent and frequent music have it to offer.
        await prisma.play.create({ data: { userId: USER, trackId: id } });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: id } });
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

    it.each(Object.entries(SONG).filter(([kind]) => kind !== "playable"))("answers not-found for the %s song", async (_kind, id) => {
        const res = await answer(id);
        expect(res.status).toBe(200);
        expect(subsonicBody(res)).toMatchObject({ status: "failed", error: { code: 70 } });
    });
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

    it("are kept when a client replaces the playlist with the songs it was shown", async () => {
        await subsonic("createPlaylist.view", { playlistId: PLAYLIST, songId: [second, SONG.playable] }).expect(200);
        expect(idsOf((await reply("getPlaylist.view", { id: PLAYLIST })).playlist.entry)).toEqual([second, SONG.playable]);
        const kept = await prisma.playlistItem.findMany({ where: { playlistId: PLAYLIST }, orderBy: { rank: "asc" }, select: { trackId: true } });
        expect(kept.map((i) => i.trackId)).toEqual([second, SONG.playable, ...UNPLAYABLE]);
    });
});
