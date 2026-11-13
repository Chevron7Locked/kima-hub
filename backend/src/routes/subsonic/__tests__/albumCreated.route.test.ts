/**
 * An album in a Subsonic reply carries `created` (AlbumID3 requires it): the album's createdAt as an ISO date-time,
 * from every list type (the ORM ones and the raw ones), getAlbum and getArtist. Real router, real database.
 */

import express from "express";
import request from "supertest";
import { libraryRouter } from "../library";
import { prisma } from "../../../utils/db";

const P = "zz-sub-created";
const USER = `${P}-user`;
const ARTIST = `${P}-ar`;
const ALBUM = `${P}-al`;
const CREATED = new Date(Date.UTC(2031, 2, 4, 5, 6, 7, 89));

const app = express()
    .use(express.json())
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", libraryRouter);

const ask = (path: string, query: Record<string, string>) =>
    request(app).get(path).query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: ARTIST, name: P, normalizedName: P, identityKey: `${P}-ik`, libraryAlbumCount: 1 } });
    await prisma.album.create({
        data: { id: ALBUM, rgMbid: `${ALBUM}-rg`, artistId: ARTIST, identityKey: ALBUM, title: ALBUM, primaryType: "Album", location: "LIBRARY", year: 1999, createdAt: CREATED },
    });
    await prisma.track.create({
        data: { id: `${ALBUM}-t`, albumId: ALBUM, title: P, trackNo: 1, duration: 100, filePath: `${P}.flac`, fileModified: new Date(), fileSize: 1 },
    });
    await prisma.play.create({ data: { userId: USER, trackId: `${ALBUM}-t`, playedAt: new Date() } });
    await prisma.likedTrack.create({ data: { userId: USER, trackId: `${ALBUM}-t` } });
});

afterAll(async () => {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.likedTrack.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

const TYPES: Record<string, string>[] = [
    { type: "newest" },
    { type: "alphabeticalByName" },
    { type: "alphabeticalByArtist" },
    { type: "byYear", fromYear: "1999", toYear: "1999" },
    { type: "random" },
    { type: "recent" },
    { type: "frequent" },
    { type: "starred" },
];

it.each(TYPES)("getAlbumList2 $type gives the album its created date", async (query) => {
    const body = await ask("/getAlbumList2.view", { size: "500", ...query });
    const albums: { id: string; created?: string }[] = [body.albumList2.album ?? []].flat();
    expect(albums.find((a) => a.id === ALBUM)?.created).toBe(CREATED.toISOString());
});

it("getAlbum gives the album its created date", async () => {
    const { album } = await ask("/getAlbum.view", { id: ALBUM });
    expect(album.created).toBe(CREATED.toISOString());
});

it("getArtist gives each album its created date", async () => {
    const { artist } = await ask("/getArtist.view", { id: ARTIST });
    expect([artist.album].flat().map((a: { id: string; created?: string }) => [a.id, a.created])).toEqual([[ALBUM, CREATED.toISOString()]]);
});
