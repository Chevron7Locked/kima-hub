/**
 * Every Subsonic list that names a cover gives it as the id getCoverArt takes: the entity's id, with the stored cover's
 * version after an underscore (`<id>_<version>`) when it has one, so a changed cover is a new id. An album shows its
 * own cover when the person set one, else the one Kima found; a cover stored before versions existed keeps the plain id.
 * Real database, real routers; only Subsonic auth is injected, as the parent router would.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { libraryRouter } from "../library";
import { searchRouter } from "../search";
import { starredRouter } from "../starred";
import { playlistRouter } from "../playlists";
import { queueRouter } from "../queue";
import { artistInfoRouter } from "../artistInfo";
import { splitCoverArtId, coverArtId } from "../mappers";

const P = "zz-coverids";
const USER = `${P}-user`;
const ARTIST = `${P}-ar`;
const found = { album: `${P}-al-found`, own: `${P}-al-own`, legacy: `${P}-al-legacy` };
const V = { artist: "a1a1a1a1a1", found: "b2b2b2b2b2", foundOld: "d4d4d4d4d4", own: "c3c3c3c3c3" };
const song = (album: string) => `${album}-t`;

const app = express();
app.use((req: any, _res, next) => {
    req.user = { id: USER, username: USER, role: "user" };
    next();
});
app.use("/", libraryRouter, searchRouter, starredRouter, playlistRouter, queueRouter, artistInfoRouter);

const get = async (path: string, query: Record<string, string> = {}) => {
    const res = await request(app).get(path).query({ f: "json", ...query });
    expect(res.status).toBe(200);
    return res.body["subsonic-response"];
};

/** Every object in a reply whose `id` is `id`. */
function nodes(value: unknown, id: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(value)) value.forEach((v) => nodes(v, id, out));
    else if (value && typeof value === "object") {
        if ((value as { id?: unknown }).id === id) out.push(value as Record<string, unknown>);
        Object.values(value).forEach((v) => nodes(v, id, out));
    }
    return out;
}
const coverOf = (body: unknown, id: string) => [...new Set(nodes(body, id).map((n) => n.coverArt))];

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({
        data: { id: ARTIST, name: P, normalizedName: P, identityKey: `${P}-ik`, libraryAlbumCount: 3, heroUrl: `native:artists/${ARTIST}.jpg?v=${V.artist}` },
    });
    const albums: Array<[string, Record<string, string>]> = [
        [found.album, { coverUrl: `native:albums/${found.album}.jpg?v=${V.found}` }],
        [found.own, { coverUrl: `native:albums/${found.own}.jpg?v=${V.foundOld}`, userCoverUrl: `native:albums/${found.own}.jpg?v=${V.own}` }],
        [found.legacy, { coverUrl: `native:albums/${found.legacy}.jpg` }],
    ];
    for (const [id, covers] of albums) {
        await prisma.album.create({
            data: { id, rgMbid: `${id}-rg`, artistId: ARTIST, identityKey: id, title: `${P} ${id}`, primaryType: "Album", location: "LIBRARY", ...covers },
        });
        await prisma.track.create({
            data: { id: song(id), albumId: id, title: `${P} song ${id}`, trackNo: 1, duration: 100, mime: "FLAC", filePath: `/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
    await prisma.likedTrack.create({ data: { userId: USER, trackId: song(found.album) } });
    await prisma.playlist.create({ data: { id: `${P}-pl`, userId: USER, name: `${P} list`, items: { create: { trackId: song(found.own), sort: 0, rank: "a" } } } });
});

afterAll(async () => {
    await prisma.playbackState.deleteMany({ where: { userId: USER } });
    await prisma.playlist.deleteMany({ where: { id: `${P}-pl` } });
    await prisma.likedTrack.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.$disconnect();
});

describe("the cover ids", () => {
    it("name an artist's picture with its version", async () => {
        expect(coverOf(await get("/getArtists.view"), ARTIST)).toEqual([`ar-${ARTIST}_${V.artist}`]);
        expect(coverOf(await get("/getArtist.view", { id: ARTIST }), ARTIST)).toEqual([`ar-${ARTIST}_${V.artist}`]);
        expect(coverOf(await get("/getMusicDirectory.view", { id: "1" }), ARTIST)).toEqual([`ar-${ARTIST}_${V.artist}`]);
        expect(coverOf(await get("/search3.view", { query: P }), ARTIST)).toEqual([`ar-${ARTIST}_${V.artist}`]);
    });

    it("name an artist's picture with its version in the artist info", async () => {
        const info = (await get("/getArtistInfo2.view", { id: ARTIST })).artistInfo2;
        expect(info.coverArt).toBe(`ar-${ARTIST}_${V.artist}`);
    });

    it("name an album's found cover with its version, on the album, its songs and every list it is in", async () => {
        const want = [`${found.album}_${V.found}`];
        const album = await get("/getAlbum.view", { id: found.album });
        expect(coverOf(album, found.album)).toEqual(want);
        expect(coverOf(album, song(found.album))).toEqual(want);
        expect(coverOf(await get("/getMusicDirectory.view", { id: ARTIST }), found.album)).toEqual(want);
        expect(coverOf(await get("/getAlbumList2.view", { type: "alphabeticalByName", size: "500" }), found.album)).toEqual(want);
        const found3 = await get("/search3.view", { query: P, songCount: "20" });
        expect(coverOf(found3, found.album)).toEqual(want);
        expect(coverOf(found3, song(found.album))).toEqual(want);
        expect(coverOf(await get("/getSong.view", { id: song(found.album) }), song(found.album))).toEqual(want);
        expect(coverOf(await get("/getStarred2.view"), song(found.album))).toEqual(want);
    });

    it("name an album's own cover rather than the one found", async () => {
        const want = [`${found.own}_${V.own}`];
        expect(coverOf(await get("/getAlbum.view", { id: found.own }), found.own)).toEqual(want);
        expect(coverOf(await get("/getPlaylist.view", { id: `${P}-pl` }), song(found.own))).toEqual(want);
    });

    it("leave the plain id for a cover stored before versions", async () => {
        const album = await get("/getAlbum.view", { id: found.legacy });
        expect(coverOf(album, found.legacy)).toEqual([found.legacy]);
        expect(coverOf(album, song(found.legacy))).toEqual([found.legacy]);
    });

    it("name the album's version in a saved play queue", async () => {
        await get("/savePlayQueue.view", { id: song(found.album), current: song(found.album), position: "0" });

        expect(coverOf(await get("/getPlayQueue.view"), song(found.album))).toEqual([`${found.album}_${V.found}`]);
    });
});

describe("a cover id's parts", () => {
    it.each([
        [`al1_${V.found}`, { id: "al1", prefix: "", version: V.found }],
        [`ar-x_${V.artist}`, { id: "x", prefix: "ar-", version: V.artist }],
        ["al-abc", { id: "abc", prefix: "al-", version: null }],
        ["has_underscore", { id: "has_underscore", prefix: "", version: null }],
        ["id_short", { id: "id_short", prefix: "", version: null }],
    ])("%s", (raw, parts) => {
        expect(splitCoverArtId(raw)).toEqual(parts);
    });

    it("are put together only for a version of the kind Kima stores", () => {
        expect(coverArtId("a", `native:albums/a.jpg?v=${V.found}`)).toBe(`a_${V.found}`);
        expect(coverArtId("a", "native:albums/a.jpg")).toBe("a");
        expect(coverArtId("a", "https://img.example/a.jpg")).toBe("a");
        expect(coverArtId("a", "native:albums/a.jpg?v=toolongtobeoneofours")).toBe("a");
        expect(coverArtId("a", null)).toBe("a");
    });
});
