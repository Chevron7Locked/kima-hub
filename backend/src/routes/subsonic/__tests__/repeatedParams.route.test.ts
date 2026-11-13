/**
 * A Subsonic client may repeat any parameter. Where the spec lets one repeat (star, unstar, createShare, createPlaylist,
 * updatePlaylist, savePlayQueue, savePlayQueueByIndex, scrobble) the route acts on every value; everywhere else it acts
 * on the first, and a repeated value never turns the reply into an error. Real database, real routers; only Subsonic
 * auth is injected, as the parent router would.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { compatRouter } from "../compat";
import { libraryRouter } from "../library";
import { lyricsRouter } from "../lyrics";
import { playbackRouter } from "../playback";
import { playlistRouter } from "../playlists";
import { queueRouter } from "../queue";
import { searchRouter } from "../search";
import { starredRouter } from "../starred";
import { artistInfoRouter } from "../artistInfo";

const MARK = "zz-repeated-params";
const USER = `${MARK}-user`;

let songA: string;
let songB: string;
let albumId: string;
let artistId: string;
let playlistId: string;

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    });
    app.use("/rest", compatRouter, libraryRouter, lyricsRouter, playbackRouter, playlistRouter, queueRouter, searchRouter, starredRouter, artistInfoRouter);
    return app;
}

const app = makeApp();

async function cleanup() {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artist = await prisma.artist.create({
        data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist`, libraryAlbumCount: 1 },
    });
    artistId = artist.id;
    const album = await prisma.album.create({
        data: {
            rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`,
            artistId: artist.id, location: "LIBRARY", year: 2020,
        },
    });
    albumId = album.id;
    const song = (n: number) => ({
        albumId: album.id, trackNo: n, duration: 200, mime: "FLAC", filePath: `/${MARK}/${n}.flac`,
        fileModified: new Date(), fileSize: 1000,
    });
    songA = (await prisma.track.create({ data: { title: `${MARK} a`, ...song(1) } })).id;
    songB = (await prisma.track.create({ data: { title: `${MARK} b`, ...song(2) } })).id;
    await prisma.trackLyrics.create({ data: { track_id: songA, plain_lyrics: "a line", source: "test" } });
    playlistId = (await prisma.playlist.create({ data: { userId: USER, name: `${MARK} playlist` } })).id;
});

afterAll(cleanup);

beforeEach(async () => {
    await prisma.likedTrack.deleteMany({ where: { userId: USER } });
    await prisma.playlistItem.deleteMany({ where: { playlistId } });
    await prisma.playlist.deleteMany({ where: { userId: USER, id: { not: playlistId } } });
    await prisma.shareLink.deleteMany({ where: { createdBy: USER } });
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.playbackState.deleteMany({ where: { userId: USER } });
});

const liked = async () => (await prisma.likedTrack.findMany({ where: { userId: USER } })).map((l) => l.trackId).sort();
const reply = async (path: string) => (await request(app).get(`/rest/${path}${path.includes("?") ? "&" : "?"}f=json`)).body["subsonic-response"];

describe("the parameters the Subsonic spec lets repeat act on every value", () => {
    it("star likes every id", async () => {
        const res = await reply(`star.view?id=${songA}&id=${songB}`);
        expect(res.status).toBe("ok");
        expect(await liked()).toEqual([songA, songB].sort());
    });

    it("unstar removes every id", async () => {
        await prisma.likedTrack.createMany({ data: [songA, songB].map((trackId) => ({ userId: USER, trackId })) });
        const res = await reply(`unstar.view?id=${songA}&id=${songB}`);
        expect(res.status).toBe("ok");
        expect(await liked()).toEqual([]);
    });

    it("createShare reads a blank repeated id as no id", async () => {
        const res = await reply(`createShare.view?id=${songA}&id=`);
        expect(res.status).toBe("ok");
        expect(await prisma.shareLink.count({ where: { createdBy: USER } })).toBe(1);
    });

    it("createPlaylist adds every songId in the order sent", async () => {
        const res = await reply(`createPlaylist.view?name=${MARK}-new&songId=${songB}&songId=${songA}`);
        expect(res.status).toBe("ok");
        const created = await prisma.playlist.findFirstOrThrow({ where: { userId: USER, name: `${MARK}-new` } });
        const items = await prisma.playlistItem.findMany({ where: { playlistId: created.id }, orderBy: { rank: "asc" } });
        expect(items.map((i) => i.trackId)).toEqual([songB, songA]);
    });

    it("updatePlaylist adds every songIdToAdd and removes every songIndexToRemove", async () => {
        await reply(`updatePlaylist.view?playlistId=${playlistId}&songIdToAdd=${songA}&songIdToAdd=${songB}`);
        const added = await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { rank: "asc" } });
        expect(added.map((i) => i.trackId)).toEqual([songA, songB]);

        const res = await reply(`updatePlaylist.view?playlistId=${playlistId}&songIndexToRemove=0&songIndexToRemove=1`);
        expect(res.status).toBe("ok");
        expect(await prisma.playlistItem.count({ where: { playlistId } })).toBe(0);
    });

    it("savePlayQueue stores every id", async () => {
        const res = await reply(`savePlayQueue.view?id=${songA}&id=${songB}&current=${songB}`);
        expect(res.status).toBe("ok");
        const state = await prisma.playbackState.findUniqueOrThrow({ where: { userId: USER } });
        expect((state.queue as { id: string }[]).map((q) => q.id)).toEqual([songA, songB]);
        expect(state.trackId).toBe(songB);
    });

    it("savePlayQueueByIndex stores every id", async () => {
        const res = await reply(`savePlayQueueByIndex.view?id=${songA}&id=${songB}&currentIndex=1`);
        expect(res.status).toBe("ok");
        const state = await prisma.playbackState.findUniqueOrThrow({ where: { userId: USER } });
        expect((state.queue as { id: string }[]).map((q) => q.id)).toEqual([songA, songB]);
        expect(state.trackId).toBe(songB);
    });

    it("scrobble records every id at its own time", async () => {
        const res = await reply(`scrobble.view?id=${songA}&time=1700000000000&id=${songB}&time=1700000100000`);
        expect(res.status).toBe("ok");
        const plays = await prisma.play.findMany({ where: { userId: USER } });
        expect(new Map(plays.map((p) => [p.trackId, p.playedAt.getTime()]))).toEqual(
            new Map([[songA, 1700000000000], [songB, 1700000100000]]),
        );
    });

    it("scrobble keeps each time with its own id when one time is blank", async () => {
        const res = await reply(`scrobble.view?id=${songA}&time=&id=${songB}&time=1700000100000`);
        expect(res.status).toBe("ok");
        const plays = await prisma.play.findMany({ where: { userId: USER } });
        const at = new Map(plays.map((p) => [p.trackId, p.playedAt.getTime()]));
        expect(at.get(songB)).toBe(1700000100000);
        expect(Date.now() - (at.get(songA) as number)).toBeLessThan(60_000);
    });

    it("scrobble keeps each time with its own id when one id is blank", async () => {
        const res = await reply(`scrobble.view?id=&time=1700000000000&id=${songB}&time=1700000100000`);
        expect(res.status).toBe("ok");
        const plays = await prisma.play.findMany({ where: { userId: USER } });
        expect(plays.map((p) => [p.trackId, p.playedAt.getTime()])).toEqual([[songB, 1700000100000]]);
    });
});

describe("a parameter the spec sends once answers for its first value when repeated", () => {
    const single = (): Array<[string, string, string]> => [
        // [route, the request with the parameter sent once, the same request with a second value after it]
        ["getSong", `getSong.view?id=${songA}`, `getSong.view?id=${songA}&id=${songB}`],
        ["getAlbum", `getAlbum.view?id=${albumId}`, `getAlbum.view?id=${albumId}&id=${songB}`],
        ["getArtist", `getArtist.view?id=${artistId}`, `getArtist.view?id=${artistId}&id=${songB}`],
        ["getMusicDirectory", `getMusicDirectory.view?id=${albumId}`, `getMusicDirectory.view?id=${albumId}&id=${songB}`],
        ["getLyricsBySongId", `getLyricsBySongId.view?id=${songA}`, `getLyricsBySongId.view?id=${songA}&id=${songB}`],
        ["getPlaylist", `getPlaylist.view?id=${playlistId}`, `getPlaylist.view?id=${playlistId}&id=${songB}`],
        ["getArtistInfo2", `getArtistInfo2.view?id=${artistId}`, `getArtistInfo2.view?id=${artistId}&id=${songB}`],
        ["getAlbumList2 type", "getAlbumList2.view?type=newest", "getAlbumList2.view?type=newest&type=random"],
        ["getAlbumList2 size", "getAlbumList2.view?size=1", "getAlbumList2.view?size=1&size=500"],
        ["getRandomSongs size", "getRandomSongs.view?size=1", "getRandomSongs.view?size=1&size=500"],
        ["search3 query", `search3.view?query=${MARK}+a`, `search3.view?query=${MARK}+a&query=nothing`],
        ["search3 songCount", `search3.view?query=${MARK}&songCount=1`, `search3.view?query=${MARK}&songCount=1&songCount=20`],
        ["setRating", `setRating.view?id=${songA}&rating=3`, `setRating.view?id=${songA}&id=${songB}&rating=3&rating=0`],
        ["createBookmark", `createBookmark.view?id=${songA}&position=5`, `createBookmark.view?id=${songA}&id=${songB}&position=5&position=9`],
        ["deleteBookmark", `deleteBookmark.view?id=${songA}`, `deleteBookmark.view?id=${songA}&id=${songB}`],
        ["getLyrics", `getLyrics.view?artist=${MARK}+Artist&title=${MARK}+a`, `getLyrics.view?artist=${MARK}+Artist&artist=x&title=${MARK}+a&title=y`],
        ["updateShare", "updateShare.view?id=nope", "updateShare.view?id=nope&id=nope2"],
    ];

    it.each(single().map((s) => s[0]))("%s", async (name) => {
        const [, once, repeated] = single().find((s) => s[0] === name)!;
        const expected = await reply(once);
        const actual = await reply(repeated);
        // The reply carries no clock or id of its own, so a first-value answer is the same reply. A random pick
        // differs from run to run, so only its size is compared.
        if (name === "getRandomSongs size") {
            expect([actual.randomSongs.song.length, expected.randomSongs.song.length]).toEqual([1, 1]);
        } else {
            expect(actual).toEqual(expected);
        }
        if (name !== "updateShare") expect(actual.status).toBe("ok");
    });
});
