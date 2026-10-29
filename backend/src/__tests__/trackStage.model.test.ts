/**
 * The stage-record schema, driven through the migrated DDL: one `TrackStage`
 * per track and stage, and one `SourceAttempt` row per source.
 */

import { prisma } from "../utils/db";

jest.mock("../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const ARTIST = "art_stage_test";
const ALBUM = "alb_stage_test";
const TRACK = "trk_stage_test";

/** Seed the FK chain TrackStage.trackId must point at. */
async function seedTrack(): Promise<void> {
    await prisma.artist.create({
        data: { id: ARTIST, name: "Stage Test Artist", identityKey: "a_stage_test" },
    });
    await prisma.album.create({
        data: { id: ALBUM, rgMbid: "rg_stage_test", artistId: ARTIST, title: "Stage Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: TRACK, albumId: ALBUM, title: "Stage Track", trackNo: 1, duration: 180,
            filePath: "/tmp/stage_test.flac", fileModified: new Date(), fileSize: 1000,
        },
    });
}

/** Every column the design lists as required on TrackStage. */
const REQUIRED_COLUMNS = [
    "status", "source", "attempt", "lastErrorCode", "lastErrorMessage",
    "failureClass", "retryable", "nextRetryAt", "evidence", "startedAt", "finishedAt",
];

async function columnNames(table: string): Promise<string[]> {
    const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, table,
    );
    return rows.map((r) => r.column_name);
}

describe("TrackStage", () => {
    beforeAll(async () => {
        await seedTrack();
    });

    afterEach(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" = $1`, TRACK);
        await prisma.$executeRawUnsafe(`DELETE FROM "SourceAttempt" WHERE source = 'acoustid'`);
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" = $1`, TRACK);
        await prisma.$executeRawUnsafe(`DELETE FROM "SourceAttempt" WHERE source = 'acoustid'`);
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id = $1`, TRACK);
        await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, ALBUM);
        await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, ARTIST);
    });

    it("declares every required field", async () => {
        const cols = await columnNames("TrackStage");
        for (const field of REQUIRED_COLUMNS) {
            expect(cols).toContain(field);
        }
    });

    it("stores and reads back every required field", async () => {
        const started = new Date(Date.UTC(2026, 8, 20, 10, 0, 0));
        const finished = new Date(Date.UTC(2026, 8, 20, 10, 1, 30));
        const nextRetry = new Date(Date.UTC(2026, 8, 21, 0, 0, 0));
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage"
                (id, "trackId", stage, status, source, attempt,
                 "lastErrorCode", "lastErrorMessage", "failureClass", retryable,
                 "nextRetryAt", evidence, "startedAt", "finishedAt")
             VALUES ($1, $2, 'analysis', 'failed', 'analyzer', 3,
                    'DAMAGED', 'flac: decode_frame overrun', 'DAMAGED', false,
                    $3, $4::jsonb, $5, $6)`,
            "ts_all", TRACK, nextRetry,
            JSON.stringify({ probe: "ffmpeg -i", rc: 1, stderr: "decode_frame overrun", channels: 1 }),
            started, finished,
        );

        const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
            `SELECT * FROM "TrackStage" WHERE id = 'ts_all'`,
        );
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.status).toBe("failed");
        expect(row.source).toBe("analyzer");
        expect(row.attempt).toBe(3);
        expect(row.lastErrorCode).toBe("DAMAGED");
        expect(row.failureClass).toBe("DAMAGED");
        expect(row.retryable).toBe(false);
        // evidence is a JSON column — the stored document must round-trip.
        expect(row.evidence).toMatchObject({ probe: "ffmpeg -i", rc: 1, channels: 1 });
        expect(new Date(row.startedAt as string).toISOString()).toBe(started.toISOString());
        expect(new Date(row.finishedAt as string).toISOString()).toBe(finished.toISOString());
    });

    it("enforces the unique (trackId, stage) constraint", async () => {
        // First attempt for the analysis stage is accepted.
        await prisma.$executeRawUnsafe(
            `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
             VALUES ('ts_first', $1, 'analysis', 'failed', 'analyzer', 1, true, $2::jsonb)`,
            TRACK, JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
        );
        // A second attempt for the SAME stage on the SAME track must be rejected.
        await expect(
            prisma.$executeRawUnsafe(
                `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
                 VALUES ('ts_second', $1, 'analysis', 'pending', 'analyzer', 0, true, $2::jsonb)`,
                TRACK, JSON.stringify({ probe: "ffmpeg -i", rc: 1 }),
            ),
        ).rejects.toThrow(/23505|already exists/);

        // A different stage on the same track is a distinct question and is allowed.
        await expect(
            prisma.$executeRawUnsafe(
                `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
                 VALUES ('ts_vibe', $1, 'vibe', 'pending', 'clap', 0, true, $2::jsonb)`,
                TRACK, JSON.stringify({ probe: "clap", rc: 0 }),
            ),
        ).resolves.toBeDefined();
    });

    it("has a per-source record with a unique source", async () => {
        const cols = await columnNames("SourceAttempt");
        for (const field of ["source", "status", "attempt", "retryable", "nextRetryAt", "evidence"]) {
            expect(cols).toContain(field);
        }

        // Clear first: the migration seeds an `acoustid` row, so a plain INSERT
        // would hit the very constraint this test is asserting rather than
        // proving it.
        await prisma.$executeRawUnsafe(
            `DELETE FROM "SourceAttempt" WHERE source = 'acoustid'`,
        );

        await prisma.$executeRawUnsafe(
            `INSERT INTO "SourceAttempt"
                (id, source, status, attempt, "lastErrorCode", "lastErrorMessage",
                 "failureClass", retryable, "nextRetryAt", evidence)
             VALUES ('sa_acoustid', 'acoustid', 'blocked', 5, 'RATE_LIMIT',
                     'AcoustID 429', 'quota', true, $1, $2::jsonb)`,
            new Date(Date.now() + 60_000),
            JSON.stringify({ source: "acoustid", window: "30s" }),
        );
        // One row per source — a second record for the same source must fail.
        await expect(
            prisma.$executeRawUnsafe(
                `INSERT INTO "SourceAttempt" (id, source, status, attempt, retryable, evidence)
                 VALUES ('sa_acoustid_2', 'acoustid', 'pending', 0, true, $1::jsonb)`,
                JSON.stringify({ source: "acoustid" }),
            ),
        ).rejects.toThrow(/23505|already exists/);
    });

    it("backs the per-stage queue with a (stage, status, nextRetryAt) index", async () => {
        // getNextWork runs one query over TrackStage keyed by
        // stage + status + nextRetryAt.
        const rows = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
            `SELECT indexdef FROM pg_indexes
             WHERE tablename = 'TrackStage'
               AND indexdef ILIKE '%stage%status%nextRetryAt%'`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
    });
});