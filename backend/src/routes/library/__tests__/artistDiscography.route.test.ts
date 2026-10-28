/**
 * The artist page lists MusicBrainz albums the library does not have. An album
 * already in the library, under its own id or as another edition, is not
 * offered again.
 */

jest.mock("../../../middleware/auth", () => ({
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn(), del: jest.fn(), disconnect: jest.fn() },
}));
// These tests are about the artist page, not Deezer: its popular-songs fallback answers "no top list" here rather
// than reaching the real service.
jest.mock("../../../services/deezer", () => ({
    deezerService: { getArtistTopTracks: jest.fn().mockResolvedValue([]) },
}));

const mockGetReleaseGroups = jest.fn();
jest.mock("../../../services/musicbrainz", () => ({
    musicBrainzService: { getReleaseGroups: (...a: unknown[]) => mockGetReleaseGroups(...a) },
}));
jest.mock("../../../services/artwork", () => ({
    findArtistArtwork: jest.fn().mockResolvedValue(null),
    withAlbumArtwork: jest.fn(async (items: unknown[]) => items),
}));
jest.mock("../../../services/artistSimilarity", () => ({ getSimilarArtists: jest.fn().mockResolvedValue([]) }));

import express from "express";
import request from "supertest";
import artistRoutes from "../artists";
import { prisma } from "../../../utils/db";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const ARTIST = "disco_interpol";
const MBID = "b23e8a63-8f47-4882-b55b-df2c92ef400e";

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: "disco_user", role: "user" };
        next();
    });
    app.use("/", artistRoutes);
    return app;
}

const releaseGroup = (id: string, title: string) => ({
    id,
    title,
    "primary-type": "Album",
    "secondary-types": [],
    "first-release-date": "2004-09-27",
});

const album = (id: string, rgMbid: string, title: string) =>
    prisma.album.create({
        data: {
            id, rgMbid, artistId: ARTIST, title, identityKey: id, sortName: title,
            primaryType: "Album", location: "LIBRARY",
        },
    });

beforeAll(async () => {
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.artist.create({
        data: {
            id: ARTIST, mbid: MBID, name: "Interpol", identityKey: "disco_interpol",
            sortName: "interpol", normalizedName: "disco_interpol",
        },
    });
    await album("disco_antics", "rg-local-antics", "Antics (Deluxe Edition)");
    await album("disco_maps", "rg-our-love", "Our Love to Admire");
});

afterAll(async () => {
    await prisma.album.deleteMany({ where: { artistId: ARTIST } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await closeEngineConnections();
});

it("offers only albums the library has in no edition", async () => {
    mockGetReleaseGroups.mockResolvedValue({
        kind: "answered",
        value: [
            releaseGroup("rg-antics", "Antics"),
            releaseGroup("rg-our-love", "Our Love To Admire (2007)"),
            releaseGroup("rg-bright", "Turn on the Bright Lights"),
        ],
    });

    const res = await request(makeApp()).get(`/artists/${ARTIST}`);

    expect(res.status).toBe(200);
    const titles = res.body.albums.map((a: any) => `${a.title}|${a.source}`).sort();
    expect(titles).toEqual([
        "Antics (Deluxe Edition)|database",
        "Our Love to Admire|database",
        "Turn on the Bright Lights|musicbrainz",
    ]);
});
