/**
 * The album vote against AcoustID replies: a rejected fingerprint, a song on several recordings, and remembered verdicts.
 * AcoustID is emulated from its server source: in a batch an invalid fingerprint is skipped silently (its index is
 * absent from the reply); only when no valid entry was collected and the last is invalid does the whole request fail
 * (HTTP 400, code 3).
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { acoustidService } from "../acoustidService";
import { identifyAlbumsBySound, voteAlbumReleaseGroup } from "../albumIdentification";

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
jest.mock("../artwork", () => ({
    ...jest.requireActual("../artwork"),
    findAlbumArtwork: jest.fn().mockResolvedValue(null),
}));

const P = "albv";
const id = (s: string) => `${P}_${s}`;
const TEMP = `temp-${P}-dd`;
const BAD = "BAD-FINGERPRINT";
const BAD_DURATION = "FINGERPRINT-WITH-REFUSED-DURATION";

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

const batchSizes: number[] = [];
const mockPost = jest.fn(async (_url: string, body: string) => {
    const fields = Object.fromEntries(body.split("&").map((pair) => pair.split("=").map(decodeURIComponent)));
    const keys = Object.keys(fields).filter((k) => k.startsWith("fingerprint."));
    batchSizes.push(keys.length);
    const valid = keys.filter((k) => fields[k] !== BAD && fields[k] !== BAD_DURATION);
    if (valid.length === 0) {
        // acoustid-server: code 3 invalid fingerprint, code 8 invalid duration.
        const code = fields[keys[0]] === BAD_DURATION ? 8 : 3;
        throw { response: { status: 400, data: { status: "error", error: { code, message: "refused" } } } };
    }
    return { data: { status: "ok", fingerprints: valid.map((k) => ({ index: Number(k.split(".")[1]), results: resultsByFingerprint.get(fields[k]) ?? [] })) } };
});

async function clearRedis() {
    for (const pattern of ["acoustid:lookup:*", "acoustid:album-vote:*"]) {
        const keys = await redisClient.keys(pattern);
        if (keys.length > 0) await redisClient.del(...keys);
    }
}
async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${P}_%`);
}

async function seedAlbum(opts: { badSongIndex?: number } = {}) {
    await prisma.artist.create({ data: { id: id("art"), name: "Perturbator", identityKey: id("art") } });
    await prisma.album.create({
        data: { id: id("alb"), title: "Dangerous Days", identityKey: "dangerousdays", artistId: id("art"), rgMbid: TEMP, primaryType: "Album", location: "LIBRARY" },
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
            acoustidFingerprint: i === opts.badSongIndex ? BAD : input.fingerprint,
        })),
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
         SELECT t || '__fingerprint', t, 'fingerprint', 'done', 'fpcalc', 1, true, '{}'::jsonb
           FROM unnest($1::text[]) AS t`,
        recorded.request.inputs.map((_, i) => id(`t${String(i).padStart(2, "0")}`)),
    );
}
const album = () => prisma.album.findUnique({ where: { id: id("alb") } });

async function letTheMissingReplyHoldExpire() {
    for (const key of await redisClient.keys("acoustid:album-vote:*")) await redisClient.del(key);
}

beforeAll(waitForRedisReady);
beforeEach(async () => {
    jest.clearAllMocks();
    batchSizes.length = 0;
    (acoustidService as any).client = { post: mockPost };
    (acoustidService as any).batchesHeldUntil = 0;
    mockGetAlbumCatalogue.mockImplementation(async (rgMbid: string) => ({
        kind: "answered",
        value: { releaseGroupMbid: rgMbid, releaseMbid: "95353672-acb7-4bb4-ad41-a5e52e51bdc6", originalYear: 2014, label: "Blood Music", genres: [], recordings: [] },
        evidence: {},
    }));
    await cleanup();
    await clearRedis();
});
afterAll(async () => {
    await cleanup();
});

describe("one song whose fingerprint AcoustID rejects", () => {
    it("12 of 13 songs agree: the album is still decided", async () => {
        await seedAlbum({ badSongIndex: 12 });
        for (let round = 0; round < 3; round++) {
            await letTheMissingReplyHoldExpire();
            await identifyAlbumsBySound([id("alb")]);
        }
        expect((await album())?.rgMbid).not.toBe(TEMP);
    });

    it("the rejected song counts as no pick and is not sent again, so batches are never held for everyone", async () => {
        await seedAlbum({ badSongIndex: 12 });
        await identifyAlbumsBySound([id("alb")]);
        await letTheMissingReplyHoldExpire();
        batchSizes.length = 0;
        await identifyAlbumsBySound([id("alb")]);

        expect(batchSizes).toEqual([]);
        expect(await acoustidService.mayAskInBatches()).toBe(true);
    });

    it("a request holding only rejected fingerprints (HTTP 400) saves them as no pick and holds no batches", async () => {
        const asked = await acoustidService.lookupMany([{ duration: 200, fingerprint: BAD }]);

        expect(asked).toBe(1);
        expect(batchSizes).toEqual([1]);
        expect(await acoustidService.hasSavedReply(200, BAD)).toBe(true);
        expect(await acoustidService.savedAnswer(200, BAD, "Song")).toBeNull();
        expect(await acoustidService.mayAskInBatches()).toBe(true);
    });

    it("a request AcoustID refuses for its duration (HTTP 400, code 8) saves the song as no pick and holds no batches", async () => {
        const asked = await acoustidService.lookupMany([{ duration: 200, fingerprint: BAD_DURATION }]);

        expect(asked).toBe(1);
        expect(await acoustidService.hasSavedReply(200, BAD_DURATION)).toBe(true);
        expect(await acoustidService.mayAskInBatches()).toBe(true);
        const alone = await acoustidService.lookup(201, BAD_DURATION, { title: "Song" });
        expect(alone.kind).toBe("absent");
        expect(await acoustidService.hasSavedReply(201, BAD_DURATION)).toBe(true);
    });

    it("a duration that rounds to 0 seconds is never sent", async () => {
        expect(await acoustidService.lookupMany([{ duration: 0.4, fingerprint: "SOME-FINGERPRINT" }])).toBe(0);
        const alone = await acoustidService.lookup(0.4, "SOME-FINGERPRINT", { title: "Song" });

        expect(alone.kind).toBe("permanent");
        expect(mockPost).not.toHaveBeenCalled();
    });

    it("asking about one rejected fingerprint on its own saves it as no pick as well", async () => {
        const out = await acoustidService.lookup(200, BAD, { title: "Song" });

        expect(out.kind).toBe("absent");
        expect(await acoustidService.hasSavedReply(200, BAD)).toBe(true);
    });
});

describe("a song votes for the albums of every recording that is the song", () => {
    it("an album listed only on the second title-matching recording still gets the song's vote", async () => {
        const keyOf = (fp: string) => (acoustidService as any).replyKey(200, fp) as string;
        const albumX = { id: "x-rg", title: "Album X" };
        const other = { id: "o-rg", title: "A Compilation" };
        const fps = ["fp-a", "fp-b", "fp-c"];
        for (const fp of fps) {
            await (acoustidService as any).saveResults(keyOf(fp), [
                {
                    id: "r",
                    score: 0.99,
                    recordings: [
                        { id: "rec-closer", title: "Song", duration: 200, artists: [{ id: "a", name: "A" }], releasegroups: [other] },
                        { id: "rec-further", title: "Song", duration: 203, artists: [{ id: "a", name: "A" }], releasegroups: [albumX] },
                    ],
                },
            ]);
        }
        const answers = [];
        for (const fp of fps) {
            const a = await acoustidService.savedAnswer(200, fp, "Song");
            answers.push({ pick: a ? { titleAgrees: a.titleAgrees, releaseGroups: a.releaseGroups } : null });
        }
        expect(voteAlbumReleaseGroup("Album X", answers).kind).toBe("assign");
    });
});

describe("albums with a remembered verdict", () => {
    it("a round over albums that all have a remembered verdict loads no tracks", async () => {
        await prisma.artist.create({ data: { id: id("art"), name: "Perturbator", identityKey: id("art") } });
        for (let n = 0; n < 5; n++) {
            await prisma.album.create({
                data: { id: id(`a${n}`), title: `Obscure ${n}`, identityKey: `obscure${n}`, artistId: id("art"), rgMbid: `temp-${P}-${n}`, primaryType: "Album", location: "LIBRARY" },
            });
            await prisma.track.create({
                data: { id: id(`x${n}`), albumId: id(`a${n}`), title: "Song", trackNo: 1, duration: 200, filePath: `${P}/x${n}.mp3`, fileModified: new Date(), fileSize: 1, acoustidFingerprint: null },
            });
            await prisma.$executeRawUnsafe(
                `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
                 VALUES ($1, $2, 'fingerprint', 'done', 'fpcalc', 1, true, '{}'::jsonb)`,
                `${id(`x${n}`)}__fingerprint`,
                id(`x${n}`),
            );
        }
        await identifyAlbumsBySound([]);
        const spy = jest.spyOn(prisma.track, "findMany");
        await identifyAlbumsBySound([]);
        const loads = spy.mock.calls.length;
        spy.mockRestore();
        expect(loads).toBe(0);
    });
});

describe("a tracklist saved before the answer named its release group", () => {
    it("still decides the album, with the release group the vote picked", async () => {
        mockGetAlbumCatalogue.mockResolvedValue({
            kind: "answered",
            value: { releaseMbid: "95353672-acb7-4bb4-ad41-a5e52e51bdc6", originalYear: 2014, label: "Blood Music", genres: [], recordings: [] },
            evidence: {},
        });
        await seedAlbum();

        expect(await identifyAlbumsBySound([id("alb")])).toEqual([id("alb")]);

        expect((await album())?.rgMbid).toBe("f765fa78-96b2-4a72-b8c7-c1d7eecbae92");
    });
});

describe("a remembered verdict and a changed file", () => {
    it("is made again once a song's file changed on disk (a retag), not before", async () => {
        await seedAlbum();
        await prisma.album.update({ where: { id: id("alb") }, data: { title: "Dangerous Days (Live)" } });
        await identifyAlbumsBySound([id("alb")]);
        expect(JSON.parse((await redisClient.get(`acoustid:album-vote:${id("alb")}`))!)).toMatchObject({ outcome: "no-agreeing-album" });
        for (const key of await redisClient.keys("acoustid:lookup:*")) await redisClient.del(key);
        mockPost.mockClear();

        await identifyAlbumsBySound([id("alb")]);
        expect(mockPost).not.toHaveBeenCalled();

        await prisma.track.update({ where: { id: id("t00") }, data: { fileModified: new Date("2030-01-01T00:00:00Z") } });
        await identifyAlbumsBySound([id("alb")]);
        expect(mockPost).toHaveBeenCalled();
    });
});
