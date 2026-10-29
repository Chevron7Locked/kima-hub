/**
 * The artist image, similar-artist images, discography and album routes all get
 * artwork through `artwork.ts`, and no response carries a guessed Cover Art
 * Archive address. Failure and boundary paths first, happy path last.
 */

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
    },
}));

// Similar artists come from the local-centroid / ListenBrainz engine; mock it so
// the suite stays offline.
const mockGetSimilarArtists = jest.fn();
jest.mock("../../services/artistSimilarity", () => ({
    getSimilarArtists: (...a: unknown[]) => mockGetSimilarArtists(...a),
    enrichSimilarArtists: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../services/wikidata", () => ({
    wikidataService: {
        getArtistInfo: jest.fn().mockResolvedValue(null),
    },
}));

const mockSearchArtist = jest.fn();
const mockGetArtist = jest.fn();
const mockGetReleaseGroups = jest.fn();
const mockGetReleaseGroup = jest.fn();
const noData = { kind: "absent", evidence: { mocked: true } } as const;
const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: (...a: unknown[]) => mockSearchArtist(...a),
        // Called first when the route is given an id and no name; without it
        // the handler never reaches the artwork lookup at all.
        getArtist: (...a: unknown[]) => mockGetArtist(...a),
        getReleaseGroups: (...a: unknown[]) => mockGetReleaseGroups(...a),
        getReleaseGroup: (...a: unknown[]) => mockGetReleaseGroup(...a),
        getRelease: jest.fn().mockResolvedValue(noData),
    },
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        getTrackPreview: jest.fn().mockResolvedValue(null),
        getFreshTrackPreview: jest.fn().mockResolvedValue(null),
    },
}));

const mockWithAlbumArtwork = jest.fn();
const mockFindAlbumArtwork = jest.fn();
const mockFindArtistArtwork = jest.fn();
jest.mock("../../services/artwork", () => ({
    withAlbumArtwork: (...a: unknown[]) => mockWithAlbumArtwork(...a),
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
}));

import { redisClient } from "../../utils/redis";
import express from "express";
import request from "supertest";
import artistRoutes from "../artists";

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/artists", artistRoutes);
    return app;
}

const MBID = "11111111-2222-3333-4444-555555555555";
const ARTIST_IMG = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const COVER = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

describe("the discovery routes and the pictures they promise", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSimilarArtists.mockResolvedValue([]);
        mockSearchArtist.mockResolvedValue(noData);
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Perturbator", id: MBID }));
        mockGetReleaseGroups.mockResolvedValue(noData);
        mockGetReleaseGroup.mockResolvedValue(noData);
        mockFindArtistArtwork.mockResolvedValue(null);
        mockFindAlbumArtwork.mockResolvedValue(null);
        // Stand in for the real helper: null every cover unless a test says so.
        mockWithAlbumArtwork.mockImplementation(
            async (items: any[], _read: any, write: any) => items.map((i) => write(i, null)),
        );
    });

    describe("GET /artists/discover/:nameOrMbid", () => {
        it("serves but does not cache a page built while MusicBrainz was failing", async () => {
            mockGetReleaseGroups.mockResolvedValue({ kind: "transient", error: { message: "timeout" } });
            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);
            expect(res.status).toBe(200);
            expect(redisClient.setex).not.toHaveBeenCalled();
        });

        it("caches a page MusicBrainz answered in full", async () => {
            await request(makeApp()).get(`/artists/discover/${MBID}`);
            expect(redisClient.setex).toHaveBeenCalled();
        });

        it("sends no artist image when no source had one", async () => {
            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(res.status).toBe(200);
            expect(res.body.image).toBeNull();
        });

        it("goes through the one door rather than its own three-source chain", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: ARTIST_IMG, source: "fanart" });

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ mbid: MBID }),
            );
            expect(res.body.image).toBe(ARTIST_IMG);
        });

        it("asks about each similar artist too, by name and by id", async () => {
            mockGetSimilarArtists.mockResolvedValue([
                {
                    name: "Carpenter Brut",
                    mbid: "sim-1",
                    match: 0.9,
                    url: "https://musicbrainz.org/artist/sim-1",
                },
            ]);
            mockFindArtistArtwork.mockResolvedValue({ url: ARTIST_IMG, source: "deezer" });

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockGetSimilarArtists).toHaveBeenCalledWith(
                MBID,
                "Perturbator",
                10,
                { interactive: true },
            );
            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ name: "Carpenter Brut", mbid: "sim-1" }),
            );
            expect(res.body.similarArtists[0].image).toBe(ARTIST_IMG);
        });

        it("sources similar artists only through the artistSimilarity engine", async () => {
            mockGetSimilarArtists.mockResolvedValue([
                { name: "Carpenter Brut", mbid: null, match: 0.8, url: "" },
            ]);
            mockFindArtistArtwork.mockResolvedValue(null);

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: "Carpenter Brut",
                    mbid: undefined,
                }),
            );
            expect(res.body.similarArtists[0]).toEqual({
                id: "Carpenter Brut",
                name: "Carpenter Brut",
                mbid: null,
                url: "",
                image: null,
            });
        });

        it("runs the whole discography through the artwork sources", async () => {
            mockGetReleaseGroups.mockResolvedValue(answeredWith([
                { id: "rg-1", title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-05-01" },
            ]));
            mockWithAlbumArtwork.mockImplementation(
                async (items: any[], _read: any, write: any) => items.map((i) => write(i, COVER)),
            );

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(mockWithAlbumArtwork).toHaveBeenCalled();
            expect(res.body.albums[0].coverUrl).toBe(COVER);
        });

        it("names each album by its release-group id when it asks", async () => {
            mockGetReleaseGroups.mockResolvedValue(answeredWith([
                { id: "rg-1", title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-05-01" },
            ]));

            await request(makeApp()).get(`/artists/discover/${MBID}`);

            const [items, read] = mockWithAlbumArtwork.mock.calls[0];
            expect(read(items[0])).toEqual(
                expect.objectContaining({ rgMbid: "rg-1", albumTitle: "Dangerous Days" }),
            );
        });

        it("carries no guessed archive address in its response", async () => {
            mockGetReleaseGroups.mockResolvedValue(answeredWith([
                { id: "rg-1", title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-05-01" },
            ]));

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(JSON.stringify(res.body)).not.toContain("front-500");
        });
    });

    describe("GET /artists/album/:mbid", () => {
        it("refuses an id MusicBrainz could never have issued", async () => {
            const res = await request(makeApp()).get("/artists/album/not-a-uuid");

            expect(res.status).toBe(404);
            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
        });

        it("sends null rather than an address it knows may 404", async () => {
            mockGetReleaseGroup.mockResolvedValue(answeredWith({
                id: MBID,
                title: "Dangerous Days",
                "artist-credit": [{ name: "Perturbator" }],
                releases: [],
            }));

            const res = await request(makeApp()).get(`/artists/album/${MBID}`);

            expect(res.status).toBe(200);
            expect(res.body.coverUrl).toBeNull();
            expect(JSON.stringify(res.body)).not.toContain("front-500");
        });

        it("sends what the sources found", async () => {
            mockGetReleaseGroup.mockResolvedValue(answeredWith({
                id: MBID,
                title: "Dangerous Days",
                "artist-credit": [{ name: "Perturbator" }],
                releases: [],
            }));
            mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });

            const res = await request(makeApp()).get(`/artists/album/${MBID}`);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith(
                expect.objectContaining({ albumTitle: "Dangerous Days" }),
            );
            expect(res.body.coverUrl).toBe(COVER);
        });
    });

    describe("whole replies", () => {
        it("an artist page lists every album as not owned, with the bio and genres twice for older clients", async () => {
            const { wikidataService } = require("../../services/wikidata");
            wikidataService.getArtistInfo.mockResolvedValue({ summary: "A synthwave artist.", heroUrl: "h" });
            mockGetArtist.mockImplementation(async (_id: string, includes?: string[]) =>
                answeredWith(includes ? { name: "Perturbator", genres: [{ name: "synthwave", count: 3 }, { name: "darksynth", count: 5 }] } : { name: "Perturbator" }),
            );
            mockGetReleaseGroups.mockResolvedValue(answeredWith([
                { id: "rg-1", title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-06-17" },
                { id: "rg-2", title: "Live", "primary-type": "Album", "secondary-types": ["Live"] },
            ]));

            const res = await request(makeApp()).get(`/artists/discover/${MBID}`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                mbid: MBID,
                name: "Perturbator",
                image: null,
                bio: "A synthwave artist.",
                summary: "A synthwave artist.",
                tags: ["darksynth", "synthwave"],
                genres: ["darksynth", "synthwave"],
                listeners: 0,
                playcount: 0,
                url: `https://musicbrainz.org/artist/${MBID}`,
                albums: [{
                    id: "rg-1", rgMbid: "rg-1", mbid: "rg-1", title: "Dangerous Days", type: "Album",
                    year: 2014, releaseDate: "2014-06-17", coverUrl: null, owned: false,
                }],
                topTracks: [],
                similarArtists: [],
            });
        });

        it("an album asked for by a release id is answered under its release group", async () => {
            const RELEASE = "99999999-8888-7777-6666-555555555555";
            const { musicBrainzService } = require("../../services/musicbrainz");
            musicBrainzService.getRelease.mockResolvedValueOnce(answeredWith({
                id: RELEASE,
                title: "Dangerous Days (Deluxe)",
                date: "2014-06-17",
                "release-group": { id: MBID },
                "artist-credit": [{ name: "Perturbator", artist: { id: "art-1" } }],
                media: [{ tracks: [{ id: "t1", title: "Welcome Back", position: 1, length: 61000 }] }],
            }));
            mockGetReleaseGroup.mockImplementation(async (id: string) =>
                id === MBID ? answeredWith({ id: MBID, title: "Dangerous Days", "primary-type": "Album", "first-release-date": "2014-06-17" }) : noData,
            );

            const res = await request(makeApp()).get(`/artists/album/${RELEASE}`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                id: MBID,
                rgMbid: MBID,
                mbid: RELEASE,
                releaseMbid: RELEASE,
                title: "Dangerous Days",
                artist: { name: "Perturbator", id: "art-1", mbid: "art-1" },
                year: 2014,
                type: "Album",
                coverUrl: null,
                coverArt: null,
                bio: null,
                tags: [],
                tracks: [{
                    id: `mb-${MBID}-t1`, title: "Welcome Back", trackNo: 1, discNumber: null, discSubtitle: null,
                    duration: 61, artist: { name: "Perturbator" },
                }],
                owned: false,
                source: "discovery",
            });
            expect(mockFindAlbumArtwork).toHaveBeenCalledWith(expect.objectContaining({ rgMbid: MBID }));
        });
    });
});
