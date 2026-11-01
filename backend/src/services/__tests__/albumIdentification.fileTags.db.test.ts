/**
 * The album vote asks AcoustID the same question identification does: a file with an acoustid_fingerprint tag
 * is asked about by the tag's fingerprint, so the reply the prefetch saved for the song answers the vote and
 * nothing is asked twice.
 */
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { acoustidService } from "../acoustidService";
import { prefetchAcoustidReplies } from "../acoustidIdentification";
import { identifyAlbumsBySound } from "../albumIdentification";

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));
jest.mock("../../routes/library/trackPath", () => ({
    resolveWithinMusicRoot: (p: string) => `/music/${p}`,
}));
const TAG_FP = "TAG-FINGERPRINT-FROM-PICARD";
const STORED_FP = "STORED-FPCALC-FINGERPRINT";
jest.mock("music-metadata", () => ({
    parseFile: jest.fn(async () => ({
        common: { acoustid_fingerprint: "TAG-FINGERPRINT-FROM-PICARD", artist: "Tagged Artist" },
        format: { duration: 200 },
    })),
}));
jest.mock("../artwork", () => ({
    ...jest.requireActual("../artwork"),
    findAlbumArtwork: jest.fn().mockResolvedValue(null),
}));

const P = "albtag";
let fileModifiedAt = 0; // a new time per test, so no test is answered from the tags an earlier one read
const FILE_MODIFIED = () => new Date(Date.UTC(2026, 9, 1) + fileModifiedAt);
const id = (s: string) => `${P}_${s}`;

const mockPost = jest.fn(async (_url: string, body: string) => {
    const keys = body.split("&").filter((pair) => pair.startsWith("fingerprint."));
    return { data: { status: "ok", fingerprints: keys.map((_, i) => ({ index: i, results: [] })) } };
});

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${P}_%`);
}

beforeAll(waitForRedisReady);
beforeEach(async () => {
    fileModifiedAt += 1000;
    jest.clearAllMocks();
    (acoustidService as any).client = { post: mockPost };
    (acoustidService as any).batchesHeldUntil = 0;
    for (const pattern of ["acoustid:lookup:*", "acoustid:album-vote:*"]) {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) await redisClient.del(...keys);
    }
    await cleanup();
});
afterAll(async () => {
    await cleanup();
});

async function seedTaggedAlbum() {
    await prisma.artist.create({ data: { id: id("art"), name: "Tagged Artist", identityKey: id("art") } });
    await prisma.album.create({
        data: { id: id("alb"), title: "Tagged Album", identityKey: "taggedalbum", artistId: id("art"), rgMbid: `temp-${P}`, primaryType: "Album", location: "LIBRARY" },
    });
    await prisma.track.create({
        data: {
            id: id("t1"), albumId: id("alb"), title: "Song", trackNo: 1, duration: 200, filePath: `${P}/1.mp3`,
            fileModified: FILE_MODIFIED(), fileSize: 1, acoustidFingerprint: STORED_FP,
        },
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
         VALUES ($1, $2, 'fingerprint', 'done', 'fpcalc', 1, true, '{}'::jsonb)`,
        `${id("t1")}__fingerprint`,
        id("t1"),
    );
}
const taggedSong = () => ({ id: id("t1"), title: "Song", filePath: `${P}/1.mp3`, duration: 200, acoustidFingerprint: STORED_FP, fileModified: FILE_MODIFIED() });

it("a song with a fingerprint tag is asked about once, by the tag, for the prefetch and the album vote alike, and its file is read once", async () => {
    await seedTaggedAlbum();

    const asked = await prefetchAcoustidReplies([taggedSong()]);
    await identifyAlbumsBySound([id("alb")]);

    expect(asked).toBe(1);
    expect(decodeURIComponent(mockPost.mock.calls[0][1] as string)).toContain(TAG_FP);
    expect(await acoustidService.hasSavedReply(200, TAG_FP)).toBe(true);
    // The tag's reply was empty, so the vote tried the stored fingerprint once more and no more.
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(parseFile).toHaveBeenCalledTimes(1);
});

it("an album whose remembered verdict expired is not read again while its files are unchanged", async () => {
    await seedTaggedAlbum();
    await identifyAlbumsBySound([id("alb")]);
    expect(parseFile).toHaveBeenCalledTimes(1);

    const keys = await redisClient.keys("acoustid:album-vote:*");
    await redisClient.del(...keys);
    await identifyAlbumsBySound([id("alb")]);

    expect(parseFile).toHaveBeenCalledTimes(1);
});

it("an album with a remembered verdict causes no file reads at all", async () => {
    await seedTaggedAlbum();
    await identifyAlbumsBySound([id("alb")]);
    (parseFile as jest.Mock).mockClear();

    await identifyAlbumsBySound([id("alb")]);

    expect(parseFile).not.toHaveBeenCalled();
});

it("a fingerprint tag AcoustID has no answer for does not blind the vote: the stored fingerprint is asked next", async () => {
    await seedTaggedAlbum();

    await identifyAlbumsBySound([id("alb")]);

    expect(await acoustidService.hasSavedReply(200, TAG_FP)).toBe(true);
    expect(await acoustidService.hasSavedReply(200, STORED_FP)).toBe(true);
});
