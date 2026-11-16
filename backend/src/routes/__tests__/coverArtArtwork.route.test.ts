/**
 * `/cover-art/native:<id>.jpg` (file missing on disk) and `/album-cover/:mbid`
 * go through `artwork.ts`; the latter looks up the album so Deezer can be
 * searched by artist and title. Real router, real database; the artwork sources and outside fetches are stubbed.
 */

jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: any, _res: any, next: any) => next(),
    apiLimiter: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
    },
}));

const mockSaveSystemSettings = jest.fn().mockResolvedValue(undefined);
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({}),
    saveSystemSettings: (...a: unknown[]) => mockSaveSystemSettings(...a),
}));

jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: "/tmp/kima-test-cache/transcodes" } },
    USER_AGENT: "Kima/test",
}));

// The route names an album the library lacks from MusicBrainz. These tests are about the route's own paths, not
// about MusicBrainz, so that lookup answers "not there" here rather than reaching the real service.
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroup: jest.fn().mockResolvedValue({ kind: "absent" }),
    },
}));

const mockFetchChecked = jest.fn();
jest.mock("../../utils/ssrf", () => ({
    ...jest.requireActual("../../utils/ssrf"),
    fetchChecked: (...a: unknown[]) => mockFetchChecked(...a),
}));

const mockFindAlbumArtwork = jest.fn();
jest.mock("../../services/artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
}));

import express from "express";
import request from "supertest";
import libraryCoverArtRoutes from "../library/coverArt";
import { prisma } from "../../utils/db";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";
import { flushShownChanges } from "../../services/shownChanges";

function makeApp() {
    const app = express();
    app.use(express.json());
    mountAsServer(app, "/library", libraryCoverArtRoutes, "/api/library", { standIn: true });
    return app;
}

const FOUND = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";
const P = "caart";
const ALBUM_ID = `${P}_alb`;
const RG = `${P}-rg-1`;
const NATIVE = `native:${ALBUM_ID}.jpg`;

async function wipe() {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await wipe();
    await prisma.artist.create({ data: { id: `${P}_art`, name: "Perturbator", normalizedName: "perturbator", identityKey: `${P}_ik` } });
});

afterAll(wipe);

// The album's stored cover is NATIVE, a file that is not on disk: the case that sends the route looking for a replacement.
beforeEach(async () => {
    await prisma.album.deleteMany({ where: { id: ALBUM_ID } });
    await prisma.album.create({
        data: { id: ALBUM_ID, rgMbid: RG, artistId: `${P}_art`, identityKey: `${P}_ak`, title: "Age Of Aquarius", primaryType: "Album", coverUrl: NATIVE },
    });
});

describe("the cover-art route asks every source", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockFindAlbumArtwork.mockResolvedValue(null);
    });

    describe("GET /cover-art/:id when the stored file has gone", () => {
        it("gives up honestly when no source has a replacement", async () => {
            expectLog("warn");
            const res = await request(makeApp()).get(
                "/library/cover-art/" + encodeURIComponent(NATIVE),
            );

            expect(res.status).toBe(404);
        });

        it("asks with the release-group id as well as the name, not Deezer alone", async () => {
            expectLog("warn");
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } }));

            await request(makeApp()).get(
                "/library/cover-art/" + encodeURIComponent(NATIVE),
            );

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: RG,
                artistName: "Perturbator",
                albumTitle: "Age Of Aquarius",
            });
        });

        it("answers 404 for a stored cover whose album is not in the library", async () => {
            expectLog("warn");
            const res = await request(makeApp()).get("/library/cover-art/" + encodeURIComponent(`native:${P}_nosuch.jpg`));

            expect(res.status).toBe(404);
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });

        it("remembers the replacement against the album and serves it through Kima", async () => {
            expectLog("warn");
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } }));

            const res = await request(makeApp()).get(
                "/library/cover-art/" + encodeURIComponent(NATIVE),
            );

            // Never a redirect off-site: the web app's service worker may only fetch Kima itself.
            expect(res.status).toBe(200);
            expect(res.headers.location).toBeUndefined();
            expect(mockFetchChecked).toHaveBeenCalledWith(FOUND, expect.anything());
            const album = await prisma.album.findUniqueOrThrow({ where: { id: ALBUM_ID } });
            expect(album.coverUrl).toBe(FOUND);
        });

        it("does not overwrite a cover the album has been given since", async () => {
            expectLog("warn");
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } }));
            // The path asks for this album's old file, but the album now points elsewhere.
            const newer = "https://example.invalid/newer.jpg";
            await prisma.album.update({ where: { id: ALBUM_ID }, data: { coverUrl: newer } });

            await request(makeApp()).get("/library/cover-art/" + encodeURIComponent(NATIVE));

            const album = await prisma.album.findUniqueOrThrow({ where: { id: ALBUM_ID } });
            expect(album.coverUrl).toBe(newer);
        });
    });

    describe("the library marker", () => {
        const gone = async () => {
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });
            mockFetchChecked.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } }));
            await request(makeApp()).get("/library/cover-art/" + encodeURIComponent(NATIVE));
            await flushShownChanges();
            return mockSaveSystemSettings.mock.calls.filter((c) => "libraryChangedAt" in (c[0] as object)).length;
        };
        const withSong = () =>
            prisma.track.create({
                data: { id: `${P}_t`, albumId: ALBUM_ID, title: "T", trackNo: 1, duration: 100, filePath: `/m/${P}.flac`, fileModified: new Date(), fileSize: 1 },
            });
        beforeEach(async () => {
            await flushShownChanges();
            mockSaveSystemSettings.mockClear();
        });
        afterEach(() => prisma.track.deleteMany({ where: { id: `${P}_t` } }));

        it("moves once when the replacement found for a listed album is stored", async () => {
            expectLog("warn");
            await withSong();
            expect(await gone()).toBe(1);
        });

        it("stays still when the person's own cover shows, or the album is only Discover's", async () => {
            expectLog("warn");
            expectLog("warn");
            await withSong();
            await prisma.album.update({ where: { id: ALBUM_ID }, data: { userCoverUrl: "https://pictures.example/mine.jpg" } });
            expect(await gone()).toBe(0);

            await prisma.album.update({ where: { id: ALBUM_ID }, data: { userCoverUrl: null, coverUrl: NATIVE, location: "DISCOVER" } });
            expect(await gone()).toBe(0);
        });
    });

    describe("GET /album-cover/:mbid", () => {
        it("looks up an album whose id this app invented", async () => {
            await prisma.artist.create({ data: { id: `${P}_art2`, name: "Soen", normalizedName: "soen", identityKey: `${P}_ik2` } });
            await prisma.album.create({
                data: { id: `${P}_alb2`, rgMbid: "temp-9", artistId: `${P}_art2`, identityKey: `${P}_ak2`, title: "Reliance", primaryType: "Album" },
            });
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const res = await request(makeApp()).get("/library/album-cover/temp-9");

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ coverUrl: FOUND });
            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({ rgMbid: "temp-9", artistName: "Soen", albumTitle: "Reliance" });
        });

        it("looks the album up so the sources can search Deezer by name", async () => {
            // Given only an MBID, the sources can ask the Cover Art Archive and
            // nothing else; the album's name lets them search Deezer too.

            await request(makeApp()).get(`/library/album-cover/${RG}`);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: RG,
                artistName: "Perturbator",
                albumTitle: "Age Of Aquarius",
            });
        });

        it("asks for an album the library does not have a row for", async () => {
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "coverartarchive" });

            const res = await request(makeApp()).get(`/library/album-cover/${P}-rg-unknown`);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: `${P}-rg-unknown`,
                artistName: "",
                albumTitle: "",
            });
            expect(res.status).toBe(200);
        });

        it("says so plainly when nobody has it", async () => {
            const res = await request(makeApp()).get(`/library/album-cover/${RG}`);

            expect(res.status).toBe(204);
        });

        it("hands back what any source found", async () => {
            mockFindAlbumArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });

            const res = await request(makeApp()).get(`/library/album-cover/${RG}`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ coverUrl: FOUND });
        });
    });
});
