/**
 * The similar-artists strip on GET /artists/:id gets images through
 * `artwork.ts` on both its paths, and an artist already in the library keeps the
 * library's picture. Real router, real database and Redis; the outside
 * lookups (artwork sources, similarity engine, Deezer, MusicBrainz,
 * ListenBrainz) are stubbed.
 */

jest.mock("p-limit", () => () => (fn: (...args: any[]) => any) => fn());

const mockGetSimilarArtists = jest.fn();
// Similar artists come from the local-centroid / ListenBrainz engine.
jest.mock("../../../services/artistSimilarity", () => ({
    getSimilarArtists: (...a: any[]) => mockGetSimilarArtists(...a),
    enrichSimilarArtists: jest.fn().mockResolvedValue([]),
}));

// These tests are about the artist page, not Deezer: its popular-songs fallback answers "no top list" here rather
// than reaching the real service.
jest.mock("../../../services/deezer", () => ({
    deezerService: { getArtistTopTracks: jest.fn().mockResolvedValue([]) },
}));

jest.mock("../../../services/listenBrainz", () => ({
    listenBrainzService: { getTopRecordingsForArtist: jest.fn().mockResolvedValue([]) },
}));

jest.mock("../../../services/musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroups: jest.fn().mockResolvedValue({ kind: "absent" }),
    },
}));

jest.mock("../../../services/dataCache", () => ({
    dataCacheService: { getArtistImage: jest.fn().mockResolvedValue(null) },
}));

const mockFindArtistArtwork = jest.fn();
jest.mock("../../../services/artwork", () => ({
    findArtistArtwork: (...a: any[]) => mockFindArtistArtwork(...a),
    withAlbumArtwork: async (albums: any[]) => albums,
}));

import express from "express";
import request from "supertest";
import libraryArtistRoutes from "../artists";
import { prisma } from "../../../utils/db";
import { redisClient } from "../../../utils/redis";
import { normalizeArtistName } from "../../../services/artistIdentity";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

const P = "zz-similar-art";

// The handler reads req.user directly; this router does not mount the auth
// middleware itself, so the app has to put a user on the request.
function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = { id: `${P}-user`, role: "admin" };
        next();
    });
    app.use("/library", libraryArtistRoutes);
    return app;
}

const FOUND = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const LOCAL = `native:artists/${P}-known.jpg`;
const SIMILAR_NAME = `${P} Carpenter Brut`;
const SIMILAR_MBID = `${P}-sim-mbid`;

const SUBJECT_ID = `${P}-subject`;
const KNOWN_ID = `${P}-known`;
const subjectInput = (id: string) => ({
    id,
    name: `${P} Perturbator`,
    normalizedName: normalizeArtistName(`${P} Perturbator`),
    identityKey: `${id}-ik`,
    mbid: "11111111-2222-3333-4444-555555555555",
    enrichmentStatus: "enriched" as const,
});

const clearSimilarCache = () => redisClient.del(`similar-artists:${SUBJECT_ID}`);

const setSimilarJson = (similarArtistsJson: unknown) =>
    prisma.artist.update({ where: { id: SUBJECT_ID }, data: { similarArtistsJson: similarArtistsJson as any } });

beforeAll(async () => {
    await prisma.artist.create({ data: subjectInput(SUBJECT_ID) });
});

afterAll(async () => {
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

const similarFrom = (res: any): any[] => res.body.similarArtists || [];

describe("the similar-artists strip and where its pictures come from", () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        mockFindArtistArtwork.mockResolvedValue(null);
        mockGetSimilarArtists.mockResolvedValue([]);
        await prisma.artist.deleteMany({ where: { id: KNOWN_ID } });
    });

    // The engine path caches its answer; cleared after each test so no test sees another's.
    afterEach(clearSimilarCache);

    describe("built from the artist's own enriched data", () => {
        const enriched = [{ name: SIMILAR_NAME, mbid: SIMILAR_MBID, match: 0.9 }];

        beforeEach(() => setSimilarJson(enriched));

        it("leaves the picture empty when no source had one", async () => {
            const res = await request(makeApp()).get(`/library/artists/${SUBJECT_ID}`);

            expect(res.status).toBe(200);
            const [first] = similarFrom(res);
            expect(first?.name).toBe(SIMILAR_NAME);
            expect(first?.coverArt ?? null).toBeNull();
        });

        it("asks the one door, by name and by id, rather than Deezer alone", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "fanart" });

            const res = await request(makeApp()).get(`/library/artists/${SUBJECT_ID}`);

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: SIMILAR_NAME,
                mbid: SIMILAR_MBID,
            });
            const [first] = similarFrom(res);
            expect(first?.coverArt).toBe(FOUND);
        });

        it("keeps the library's own picture instead of going out for one", async () => {
            // Already downloaded, already chosen. Replacing it would be slower
            // and worse.
            await prisma.artist.create({
                data: {
                    id: KNOWN_ID,
                    name: SIMILAR_NAME,
                    normalizedName: normalizeArtistName(SIMILAR_NAME),
                    identityKey: `${KNOWN_ID}-ik`,
                    mbid: SIMILAR_MBID,
                    heroUrl: LOCAL,
                },
            });

            const res = await request(makeApp()).get(`/library/artists/${SUBJECT_ID}`);

            const [first] = similarFrom(res);
            expect(first?.id).toBe(KNOWN_ID);
            expect(first?.coverArt).toBe(LOCAL);
            expect(mockFindArtistArtwork).not.toHaveBeenCalled();
        });
    });

    describe("built from the similarity engine", () => {
        it("asks the one door here too", async () => {
            await setSimilarJson(null);
            mockGetSimilarArtists.mockResolvedValue([
                { name: SIMILAR_NAME, mbid: SIMILAR_MBID, match: 0.9 },
            ]);
            mockFindArtistArtwork.mockResolvedValue({ url: FOUND, source: "deezer" });

            const res = await request(makeApp()).get(`/library/artists/${SUBJECT_ID}`);

            expect(res.status).toBe(200);
            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: SIMILAR_NAME,
                mbid: SIMILAR_MBID,
            });
            expect(similarFrom(res)[0]?.coverArt).toBe(FOUND);
        });
    });
});
