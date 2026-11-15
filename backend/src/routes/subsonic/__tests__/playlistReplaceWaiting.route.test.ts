/**
 * A Subsonic client replacing a playlist's songs (createPlaylist with a playlistId) cannot see the songs an import is
 * still waiting for, so the replace must not move them. Each waiting entry stays after the song that came before it,
 * as the playlist looked before the replace; when that song is no longer in the new list, after the nearest earlier
 * song that is, or first when none is. Waiting entries keep their order among themselves (an entry never moves
 * before the one that was ahead of it). Items and waiting entries share one rank space and (playlistId, rank) is
 * unique. Real database, real router.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { rankForPosition } from "../../../utils/lexoRank";
import { playlistRouter } from "../playlists";

const MARK = "zz-sub-plwaiting";
const USER = `${MARK}-user`;
const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/", playlistRouter);
const replace = (playlistId: string, songId: string[]) =>
    request(app).get("/createPlaylist.view").query({ u: USER, f: "json", playlistId, songId }).expect(200);

let songs: Record<"a" | "b" | "c" | "h", string>;
const letter = (trackId: string) => Object.entries(songs).find(([, id]) => id === trackId)![0];

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

/** A playlist whose entries sit at consecutive ranks, in the order given: a song letter, or "W<n>" for a waiting entry. */
async function playlistOf(entries: string[]) {
    const playlist = await prisma.playlist.create({ data: { userId: USER, name: `${MARK} ${Math.random()}` } });
    for (const [i, entry] of entries.entries()) {
        if (entry.startsWith("W")) {
            await prisma.playlistPendingTrack.create({
                data: { playlistId: playlist.id, spotifyArtist: "x", spotifyTitle: entry, spotifyAlbum: "x", sort: i, rank: rankForPosition(i) },
            });
        } else {
            await prisma.playlistItem.create({
                data: { playlistId: playlist.id, trackId: songs[entry as "a"], sort: i, rank: rankForPosition(i) },
            });
        }
    }
    return playlist.id;
}

/** The playlist as the web page lists it: items and waiting entries in one rank order. */
async function pageOrder(playlistId: string) {
    const [items, pending] = await Promise.all([
        prisma.playlistItem.findMany({ where: { playlistId } }),
        prisma.playlistPendingTrack.findMany({ where: { playlistId } }),
    ]);
    return [...items.map((i) => ({ rank: i.rank, what: letter(i.trackId) })), ...pending.map((p) => ({ rank: p.rank, what: p.spotifyTitle }))]
        .sort((x, y) => (x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0))
        .map((e) => e.what);
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist`, libraryAlbumCount: 1 } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    const made: string[] = [];
    for (const n of [1, 2, 3, 4]) {
        const t = await prisma.track.create({
            // Song 4 is missing: not a playable song, so a Subsonic client is never shown it.
            data: { title: `${MARK} song ${n}`, albumId: album.id, trackNo: n, duration: 100, mime: "FLAC", filePath: `/${MARK}/${n}.flac`, fileModified: new Date(), fileSize: 1, ...(n === 4 ? { missingSince: new Date() } : {}) },
        });
        made.push(t.id);
    }
    songs = { a: made[0], b: made[1], c: made[2], h: made[3] };
});

afterEach(async () => {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("replacing a playlist's songs", () => {
    it("leaves a waiting entry where it was when the songs come back the same", async () => {
        const playlistId = await playlistOf(["a", "W1", "b", "c"]);
        const before = await prisma.playlistPendingTrack.findFirstOrThrow({ where: { playlistId } });
        await replace(playlistId, [songs.a, songs.b, songs.c]);
        expect(await pageOrder(playlistId)).toEqual(["a", "W1", "b", "c"]);
        expect((await prisma.playlistPendingTrack.findUniqueOrThrow({ where: { id: before.id } })).rank).toBe(before.rank);
    });

    it("keeps a waiting entry after the song that came before it when the songs are reordered", async () => {
        const playlistId = await playlistOf(["a", "W1", "b", "c"]);
        await replace(playlistId, [songs.c, songs.b, songs.a]);
        expect(await pageOrder(playlistId)).toEqual(["c", "b", "a", "W1"]);
    });

    it("moves a waiting entry back to the nearest earlier song that is still there, or to the start", async () => {
        const playlistId = await playlistOf(["a", "b", "W1", "c"]);
        await replace(playlistId, [songs.a, songs.c]);
        expect(await pageOrder(playlistId)).toEqual(["a", "W1", "c"]);
        await replace(playlistId, [songs.c]);
        expect(await pageOrder(playlistId)).toEqual(["W1", "c"]);
    });

    it("keeps entries at the start and the end, and several in a row in their order", async () => {
        const playlistId = await playlistOf(["W1", "a", "W2", "W3", "b", "W4"]);
        await replace(playlistId, [songs.b, songs.a, songs.c]);
        // Waiting entries keep their order among themselves, so W4 (which followed "b") cannot pass W2 and W3 (which followed "a").
        expect(await pageOrder(playlistId)).toEqual(["W1", "b", "a", "W2", "W3", "W4", "c"]);
    });

    it("puts the new songs between waiting entries at ranks that are unique, however many there are", async () => {
        const playlistId = await playlistOf(["W1", "a", "W2", "W3", "b", "W4"]);
        const many = Array.from({ length: 400 }, (_, i) => [songs.a, songs.b, songs.c][i % 3]);
        await replace(playlistId, many);
        const order = await pageOrder(playlistId);
        expect(order.length).toBe(404);
        expect(order.filter((x) => x.startsWith("W"))).toEqual(["W1", "W2", "W3", "W4"]);
        // W1 had no song before it, W2 and W3 followed the first "a", W4 followed the first "b".
        expect(order.slice(0, 7)).toEqual(["W1", "a", "W2", "W3", "b", "W4", "c"]);
        const ranks = (await prisma.playlistItem.findMany({ where: { playlistId } })).map((i) => i.rank);
        expect(new Set(ranks).size).toBe(400);
        expect(Math.max(...ranks.map((r) => r.length))).toBeLessThanOrEqual(8);
    });

    it("keeps a song the client was never shown at the end, and never anchors a waiting entry to it", async () => {
        const playlistId = await playlistOf(["a", "h", "W1", "b", "W2"]);
        await replace(playlistId, [songs.b, songs.a]);
        // W1 followed the hidden song, so it stays with "a" (the shown song before it); W2 followed "b".
        expect(await pageOrder(playlistId)).toEqual(["b", "a", "W1", "W2", "h"]);
    });

    it("leaves a playlist with no waiting entries ranked as before", async () => {
        const playlistId = await playlistOf(["a", "b"]);
        await replace(playlistId, [songs.c, songs.a, songs.c]);
        expect(await pageOrder(playlistId)).toEqual(["c", "a", "c"]);
    });
});
