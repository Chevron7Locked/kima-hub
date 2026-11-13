/**
 * An album in a search3 reply is an AlbumID3: it carries `created`, `songCount` and `duration`, counting playable
 * songs only (a missing or corrupt song is not counted), as every other Subsonic album reply does. Both paths: the
 * ranked search and the empty-query enumeration. Real router, real database.
 */

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { searchRouter } from "../search";

const P = "zz-sa-fields";
const USER = `${P}-user`;
const ARTIST = `${P}-ar`;
const ALBUM = `${P}-al`;
const CREATED = new Date(Date.UTC(2031, 2, 4, 5, 6, 7, 89));

const app = express()
    .use((req: any, _res, next) => { req.user = { id: USER, username: USER, role: "user" }; next(); })
    .use("/", searchRouter);

const search = (query: Record<string, string>) =>
    request(app).get("/search3.view").query({ f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

const track = (n: number, extra: { duration: number; missingSince?: Date; corrupt?: boolean }) => ({
    id: `${ALBUM}-t${n}`, albumId: ALBUM, title: `${P} song ${n}`, trackNo: n, filePath: `${P}-${n}.flac`,
    fileModified: new Date(), fileSize: 1, ...extra,
});

beforeAll(async () => {
    await prisma.artist.create({ data: { id: ARTIST, name: `${P} artist`, normalizedName: P, identityKey: `${P}-ik`, libraryAlbumCount: 1 } });
    await prisma.album.create({
        data: { id: ALBUM, rgMbid: `${ALBUM}-rg`, artistId: ARTIST, identityKey: ALBUM, title: `${P} album`, primaryType: "Album", location: "LIBRARY", year: 1999, createdAt: CREATED },
    });
    await prisma.track.createMany({
        data: [
            track(1, { duration: 100 }),
            track(2, { duration: 50.4 }),
            track(3, { duration: 1000, missingSince: new Date() }),
            track(4, { duration: 2000, corrupt: true }),
        ],
    });
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
});

const found = (body: any) =>
    [body.searchResult3.album ?? []].flat().find((a: { id: string }) => a.id === ALBUM);

it("a ranked search gives the album created, songCount and duration of its playable songs", async () => {
    const album = found(await search({ query: `${P} album`, albumCount: "50" }));
    expect(album).toMatchObject({ created: CREATED.toISOString(), songCount: 2, duration: 150 });
});

it("an empty-query enumeration gives the album created, songCount and duration of its playable songs", async () => {
    const album = found(await search({ query: "", albumCount: "500" }));
    expect(album).toMatchObject({ created: CREATED.toISOString(), songCount: 2, duration: 150 });
});
