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
const GONE = `${P}-gone`; // a library album whose only song is missing
const DISC = `${P}-disc`; // a Discover album with a playable file
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
    await prisma.artist.create({ data: { id: ARTIST, name: `${P} artist`, displayName: `${P} shown artist`, genres: ["zz-sa-genre"], normalizedName: P, identityKey: `${P}-ik`, libraryAlbumCount: 1 } });
    await prisma.album.create({
        data: { id: ALBUM, rgMbid: `${ALBUM}-rg`, artistId: ARTIST, identityKey: ALBUM, title: `${P} album`, displayTitle: `${P} shown album`, primaryType: "Album", location: "LIBRARY", year: 1999, createdAt: CREATED },
    });
    for (const [id, location] of [[GONE, "LIBRARY"], [DISC, "DISCOVER"]] as const) {
        await prisma.album.create({
            data: { id, rgMbid: `${id}-rg`, artistId: ARTIST, identityKey: id, title: `${P} album ${id}`, primaryType: "Album", location },
        });
    }
    await prisma.track.createMany({
        data: [
            { id: `${GONE}-t`, albumId: GONE, title: P, trackNo: 1, duration: 9, filePath: `${P}-g.flac`, fileModified: new Date(), fileSize: 1, missingSince: new Date() },
            { id: `${DISC}-t`, albumId: DISC, title: P, trackNo: 1, duration: 9, filePath: `${P}-d.flac`, fileModified: new Date(), fileSize: 1 },
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

const albumsOf = (body: any): { id: string }[] => [body.searchResult3.album ?? []].flat();
const found = (body: any) => albumsOf(body).find((a) => a.id === ALBUM);

it("a ranked search gives the album created, songCount and duration of its playable songs", async () => {
    const album = found(await search({ query: `${P} album`, albumCount: "50" }));
    expect(album).toMatchObject({
        created: CREATED.toISOString(), songCount: 2, duration: 150,
        name: `${P} shown album`, artist: `${P} shown artist`, genre: "zz-sa-genre",
    });
});

it("an empty-query enumeration gives the album created, songCount and duration of its playable songs", async () => {
    const album = found(await search({ query: "", albumCount: "500" }));
    expect(album).toMatchObject({
        created: CREATED.toISOString(), songCount: 2, duration: 150,
        name: `${P} shown album`, artist: `${P} shown artist`, genre: "zz-sa-genre",
    });
});

it("an album with no playable song, or a Discover album, is not in either reply", async () => {
    for (const body of [await search({ query: P, albumCount: "50" }), await search({ query: "", albumCount: "500" })]) {
        const ids = albumsOf(body).map((a) => a.id);
        expect(ids).toContain(ALBUM);
        expect(ids).not.toContain(GONE);
        expect(ids).not.toContain(DISC);
    }
});
