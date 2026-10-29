/**
 * The error classifier speaks the same classes as `classifier.py` (DAMAGED,
 * UNSUPPORTED, MULTICANNEL, INCONCLUSIVE), and an unclassifiable error is
 * INCONCLUSIVE with its evidence kept.
 */

import { prisma } from "../utils/db";
import {
    classifyFailure,
    type FailureClass,
} from "../services/enrichmentErrorCodeClassifier";
import { recordStageFailure } from "../workers/unifiedEnrichment";
import { closeEngineConnections } from "./helpers/engineConnections";

const PREFIX = "incon";
const id = (n: string) => `${PREFIX}_${n}`;

async function putStage(trackId: string, stage: string, status: string): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, evidence)
         VALUES ($1, $2, $3, $4, 'analyzer', 0, true, $5::jsonb)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                attempt = EXCLUDED.attempt,
                retryable = EXCLUDED.retryable,
                evidence = EXCLUDED.evidence`,
        `${trackId}__${stage}`, trackId, stage, status,
        JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
    );
}

async function getRecord(trackId: string, stage: string): Promise<any> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`,
        trackId, stage,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    await wipe();
    await prisma.artist.create({
        data: { id: id("art"), name: "Incon Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Incon Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: id("t1"), albumId: id("alb"), title: "Odd Track", trackNo: 1,
            duration: 180, filePath: `/tmp/${id("t1")}.flac`,
            fileModified: new Date(), fileSize: 1000,
            analysisStatus: "pending",
        },
    });
    await putStage(id("t1"), "analysis", "working");
});

afterAll(async () => {
    await wipe();
    await closeEngineConnections();
});

describe("classifyFailure — the four classes, matching classifier.py", () => {
    it("keeps an unclassifiable error INCONCLUSIVE", () => {
        expect(classifyFailure(new Error("something went wrong"))).toBe("INCONCLUSIVE");
        expect(classifyFailure(new Error("Redis connection dropped mid-scan"))).toBe("INCONCLUSIVE");
        expect(classifyFailure("a bare string")).toBe("INCONCLUSIVE");
        expect(classifyFailure(undefined)).toBe("INCONCLUSIVE");
    });

    it("recognizes the terminal classes from the documented signatures", () => {
        expect(classifyFailure(new Error("Audio file has more than 2 channels"))).toBe("MULTICANNEL");
        expect(classifyFailure(new Error("Unsupported codec!"))).toBe("UNSUPPORTED");
        expect(classifyFailure(new Error("flac: decode_frame overrun"))).toBe("DAMAGED");
        expect(classifyFailure(new Error("mp3: Header missing"))).toBe("DAMAGED");
    });

    it("never answers with the generic Work code", () => {
        const cases = [
            new Error("something went wrong"),
            new Error("the file is unsupported"),
            new Error("checking flac decode support"),
            new Error("HTTP 429 Too Many Requests"),
        ];
        const allowed = new Set<FailureClass>(["DAMAGED", "UNSUPPORTED", "MULTICANNEL", "INCONCLUSIVE"]);
        for (const err of cases) {
            const cls = classifyFailure(err);
            expect(allowed.has(cls)).toBe(true);
            expect(cls).not.toBe("WORK");
            expect(cls).not.toBe("work");
        }
    });

    it("the old two-class API is gone, not kept alongside", () => {
        const mod = require("../services/enrichmentErrorCodeClassifier");
        expect(mod.classifyError).toBeUndefined();
        expect(mod.isQuotaError).toBeUndefined();
        expect(mod.isQuotaLikeError).toBeUndefined();
        expect(mod.categorizeError).toBeUndefined();
        expect(mod.markParked).toBeUndefined();
        expect(typeof mod.classifyFailure).toBe("function");
        expect(typeof mod.isRateLimited).toBe("function");
    });
});

describe("an unclassifiable error stays INCONCLUSIVE with its evidence", () => {
    it("recordStageFailure writes failureClass=INCONCLUSIVE and keeps the raw message", async () => {
        const err = new Error("probe said something weird (#37)");
        await recordStageFailure(id("t1"), "analysis", "analyzer", err, {
            probe: "ffmpeg -i /tmp/x.flac",
            rc: 1,
        });

        const rec = await getRecord(id("t1"), "analysis");
        expect(rec.status).toBe("failed");
        expect(rec.failureClass).toBe("INCONCLUSIVE");
        expect(rec.retryable).toBe(true);
        // The evidence keeps the raw evidence — the record is never empty.
        expect(rec.evidence).toMatchObject({
            probe: "ffmpeg -i /tmp/x.flac",
            rc: 1,
            error: "probe said something weird (#37)",
        });
    });

    it("a terminal class stays non-retryable with the class recorded", async () => {
        await recordStageFailure(id("t1"), "analysis", "analyzer", new Error("Audio file has more than 2 channels"));

        const rec = await getRecord(id("t1"), "analysis");
        expect(rec.status).toBe("failed");
        expect(rec.failureClass).toBe("MULTICANNEL");
        expect(rec.retryable).toBe(false);
        expect(rec.nextRetryAt).toBeNull();
    });
});