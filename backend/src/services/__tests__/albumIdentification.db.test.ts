/**
 * identifyAlbumsBySound on the real database and Redis, with AcoustID answering from the recorded
 * replies for all 13 songs of "Dangerous Days" (fixtures/acoustid/album-dangerous-days.json). The
 * MusicBrainz tracklist and the cover lookup are stubbed. An untagged LIBRARY album gets its
 * MusicBrainz id, its year/label/genres, a cover, its ownership kept and its unmatched songs
 * reopened; Discover albums, albums still being fingerprinted, a taken id and failures are left alone.
 */

import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { acoustidService } from "../acoustidService";
import { identifyAlbumsBySound } from "../albumIdentification";

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));
const mockGetAlbumCatalogue = jest.fn();
jest.mock("../musicbrainz", () => {
    const actual = jest.requireActual("../musicbrainz");
    actual.musicBrainzService.getAlbumCatalogue = (...args: unknown[]) => mockGetAlbumCatalogue(...args);
    return actual;
});
const mockFindAlbumArtwork = jest.fn();
jest.mock("../artwork", () => ({
    ...jest.requireActual("../artwork"),
    findAlbumArtwork: (...args: unknown[]) => mockFindAlbumArtwork(...args),
}));

const DANGEROUS_DAYS = "f765fa78-96b2-4a72-b8c7-c1d7eecbae92";
const P = "albid";
const id = (s: string) => `${P}_${s}`;
const TEMP = `temp-${P}-dd`;

type Recorded = {
    request: { inputs: { title: string; duration: number; fingerprint: string }[] };
    replies: { offset: number; reply: { fingerprints: { index: number; results: unknown[] }[] } }[];
};
const recorded: Recorded = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/acoustid/album-dangerous-days.json"), "utf8"));
const resultsByFingerprint = new Map(
    recorded.request.inputs.map((input, i) => {
        const batch = recorded.replies.find((r) => i >= r.offset && i < r.offset + 10)!;
        return [input.fingerprint, batch.reply.fingerprints.find((f) => f.index === i - batch.offset)?.results ?? []] as const;
    }),
);

/** AcoustID's batch lookup answered from the recorded replies, by fingerprint. */
const mockPost = jest.fn(async (_url: string, body: string) => {
    const fields = Object.fromEntries(body.split("&").map((pair) => pair.split("=").map(decodeURIComponent)));
    const fingerprints = Object.keys(fields)
        .filter((k) => k.startsWith("fingerprint."))
        .map((k) => ({ index: Number(k.split(".")[1]), results: resultsByFingerprint.get(fields[k]) ?? [] }));
    return { data: { status: "ok", fingerprints } };
});

const catalogue = {
    kind: "answered",
    value: { releaseMbid: "95353672-acb7-4bb4-ad41-a5e52e51bdc6", originalYear: 2014, label: "Blood Music", genres: [{ name: "synthwave", count: 4 }], recordings: [] },
    evidence: {},
};

async function clearRedis() {
    for (const pattern of ["acoustid:lookup:*", "acoustid:album-vote:*"]) {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) await redisClient.del(...keys);
    }
}

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryAlbum" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${P}_%`);
}

/** The album as scanned from untagged files: placeholder id, native-scan ownership, fingerprints in. */
async function seedAlbum(opts: { location?: "LIBRARY" | "DISCOVER"; unfingerprinted?: boolean; title?: string } = {}) {
    await prisma.artist.create({ data: { id: id("art"), name: "Perturbator", identityKey: id("art") } });
    await prisma.album.create({
        data: { id: id("alb"), title: opts.title ?? "Dangerous Days", identityKey: "dangerousdays", artistId: id("art"), rgMbid: TEMP, primaryType: "Album", location: opts.location ?? "LIBRARY" },
    });
    await prisma.ownedAlbum.create({ data: { artistId: id("art"), rgMbid: TEMP, source: "native_scan" } });
    await prisma.track.createMany({
        data: recorded.request.inputs.map((input, i) => ({
            id: id(`t${String(i).padStart(2, "0")}`),
            albumId: id("alb"),
            title: input.title,
            trackNo: i + 1,
            duration: input.duration,
            filePath: `${P}/${i}.mp3`,
            fileModified: new Date(),
            fileSize: 1000,
            acoustidFingerprint: input.fingerprint,
        })),
    });
    const stageIds = recorded.request.inputs.map((_, i) => id(`t${String(i).padStart(2, "0")}`)).slice(opts.unfingerprinted ? 1 : 0);
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
         SELECT t || '__fingerprint', t, 'fingerprint', 'done', 'fpcalc', 1, true, '{}'::jsonb FROM unnest($1::text[]) AS t`,
        stageIds,
    );
}

const album = () => prisma.album.findUnique({ where: { id: id("alb") } });

beforeAll(waitForRedisReady);
beforeEach(async () => {
    jest.clearAllMocks();
    (acoustidService as any).client = { post: mockPost };
    (acoustidService as any).batchesHeldUntil = 0;
    mockGetAlbumCatalogue.mockResolvedValue(catalogue);
    mockFindAlbumArtwork.mockResolvedValue({ url: "https://coverartarchive.org/release-group/f765fa78/front", source: "coverartarchive" });
    await cleanup();
    await clearRedis();
});
afterAll(async () => {
    await cleanup();
});

describe("identifyAlbumsBySound", () => {
    it("gives an untagged library album its MusicBrainz id, year, label, genres and cover, keeping its ownership", async () => {
        await seedAlbum();

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([id("alb")]);

        expect(await album()).toMatchObject({
            rgMbid: DANGEROUS_DAYS,
            rgMbidSource: "acoustid",
            year: 2014,
            label: "Blood Music",
            genres: ["synthwave"],
            coverUrl: "https://coverartarchive.org/release-group/f765fa78/front",
        });
        expect(await prisma.ownedAlbum.findMany({ where: { artistId: id("art") }, select: { rgMbid: true, source: true } }))
            .toEqual([{ rgMbid: DANGEROUS_DAYS, source: "native_scan" }]);
        // 13 songs asked in two requests (10 per request).
        expect(mockPost).toHaveBeenCalledTimes(2);
        expect(mockGetAlbumCatalogue).toHaveBeenCalledWith(DANGEROUS_DAYS);
    });

    it("decides an album once", async () => {
        await seedAlbum();
        await identifyAlbumsBySound([id("alb")]);
        mockPost.mockClear();

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it("reopens the album's songs that found no recording, so its tracklist can name them", async () => {
        await seedAlbum();
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ($1, $2, 'recording', 'done', 'acoustid', 1, true, '{}'::jsonb)`,
            `${id("t00")}__recording`,
            id("t00"),
        );

        await identifyAlbumsBySound([id("alb")]);

        const stage = await prisma.trackStage.findFirst({ where: { trackId: id("t00"), stage: "recording" } });
        expect(stage?.status).toBe("pending");
    });

    it("leaves a Discover album alone", async () => {
        await seedAlbum({ location: "DISCOVER" });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect((await album())?.rgMbid).toBe(TEMP);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it("waits while any of the album's songs is still being fingerprinted", async () => {
        await seedAlbum({ unfingerprinted: true });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect(mockPost).not.toHaveBeenCalled();
    });

    it("leaves both albums alone when another album already holds the id, and remembers it", async () => {
        await seedAlbum();
        await prisma.album.create({
            data: { id: id("holder"), title: "Dangerous Days", identityKey: "dangerousdays-other", artistId: id("art"), rgMbid: DANGEROUS_DAYS, primaryType: "Album" },
        });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect((await album())?.rgMbid).toBe(TEMP);
        expect(JSON.parse((await redisClient.get(`acoustid:album-vote:${id("alb")}`))!)).toMatchObject({ outcome: "collision" });
    });

    it("an AcoustID failure leaves the album undecided, put aside for two minutes so it doesn't take a slot every round", async () => {
        await seedAlbum();
        mockPost.mockRejectedValueOnce({ response: { status: 502 } });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect((await album())?.rgMbid).toBe(TEMP);
        const memoKey = `acoustid:album-vote:${id("alb")}`;
        expect(JSON.parse((await redisClient.get(memoKey))!)).toMatchObject({ outcome: "waiting-for-acoustid" });
        expect(await redisClient.ttl(memoKey)).toBeLessThanOrEqual(2 * 60);
    });

    it("a MusicBrainz failure puts the album aside for a while without deciding it", async () => {
        await seedAlbum();
        mockGetAlbumCatalogue.mockResolvedValueOnce({ kind: "transient", error: { code: "NETWORK", message: "boom", retryable: true, retryAfterMs: 60_000 } });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect((await album())?.rgMbid).toBe(TEMP);
        const memoKey = `acoustid:album-vote:${id("alb")}`;
        expect(JSON.parse((await redisClient.get(memoKey))!)).toMatchObject({ outcome: "postponed" });
        expect(await redisClient.ttl(memoKey)).toBeLessThanOrEqual(15 * 60);
    });

    it("an album MusicBrainz does not know is never given that id", async () => {
        await seedAlbum();
        mockGetAlbumCatalogue.mockResolvedValueOnce({ kind: "absent", evidence: { reason: "release group has no releases" } });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect((await album())?.rgMbid).toBe(TEMP);
        expect(JSON.parse((await redisClient.get(`acoustid:album-vote:${id("alb")}`))!)).toMatchObject({ outcome: "no-tracklist" });
    });

    it("a generic title is never asked about", async () => {
        await seedAlbum({ title: "Greatest Hits" });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect(mockPost).not.toHaveBeenCalled();
        expect(JSON.parse((await redisClient.get(`acoustid:album-vote:${id("alb")}`))!)).toMatchObject({ outcome: "generic-title" });
    });

    it("remembers an undecided album, and decides again when a song is added", async () => {
        await seedAlbum({ title: "Dangerous Days (Live)" });
        await identifyAlbumsBySound([id("alb")]);
        expect(JSON.parse((await redisClient.get(`acoustid:album-vote:${id("alb")}`))!)).toMatchObject({ outcome: "no-agreeing-album" });
        // With the saved AcoustID replies gone, only the remembered verdict keeps the album from
        // being asked about again.
        await redisClient.del(...(await redisClient.keys("acoustid:lookup:*")));
        mockPost.mockClear();

        await identifyAlbumsBySound([id("alb")]);
        expect(mockPost).not.toHaveBeenCalled();

        const first = recorded.request.inputs[0];
        await prisma.track.create({
            data: { id: id("t99"), albumId: id("alb"), title: first.title, trackNo: 99, duration: first.duration + 1, filePath: `${P}/99.mp3`, fileModified: new Date(), fileSize: 1000, acoustidFingerprint: `${first.fingerprint}x` },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ($1, $2, 'fingerprint', 'done', 'fpcalc', 1, true, '{}'::jsonb)`,
            `${id("t99")}__fingerprint`,
            id("t99"),
        );

        await identifyAlbumsBySound([id("alb")]);
        // The songs changed, so the album is decided again: all 14 asked, ten per request.
        expect(mockPost).toHaveBeenCalledTimes(2);
    });

    it("reaches an album through the backlog in one round when none of its songs is coming up", async () => {
        // A round that reaches the end of the backlog starts the next one from the top, wherever
        // earlier tests left it: with this album not yet there, the next round starts at the top.
        await identifyAlbumsBySound([]);
        await seedAlbum();

        const assigned = await identifyAlbumsBySound([]);

        expect(assigned).toContain(id("alb"));
        expect((await album())?.rgMbid).toBe(DANGEROUS_DAYS);
    });

    it("leaves an album Discover fetched alone, matched by artist and title", async () => {
        await seedAlbum();
        await prisma.user.create({ data: { id: id("u1"), username: id("user1"), passwordHash: "x" } });
        await prisma.discoveryAlbum.create({
            data: { id: id("disc"), userId: id("u1"), rgMbid: DANGEROUS_DAYS, artistName: "Perturbator", albumTitle: "Dangerous Days", weekStartDate: new Date("2026-10-12T05:00:00.000Z"), status: "LIKED" },
        });

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([]);
        expect(mockPost).not.toHaveBeenCalled();
    });
});
