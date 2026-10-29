/**
 * The migration resolves (never deletes) every open EnrichmentFailure whose
 * track has since completed that stage: track → recording, audio → analysis,
 * vibe → embedding. Running it twice changes nothing more.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { prisma } from "../utils/db";

const MIGRATION_DIR = join(__dirname, "..", "..", "prisma", "migrations", "20260925150000_resolve_stale_enrichment_failures");
const MIGRATION_SQL = join(MIGRATION_DIR, "migration.sql");

const PREFIX = "stalebf";
const id = (n: string) => `${PREFIX}_${n}`;

function readMigrationSql(): string {
    if (!existsSync(MIGRATION_SQL)) {
        throw new Error(`migration missing: ${MIGRATION_SQL}`);
    }
    return readFileSync(MIGRATION_SQL, "utf8");
}

async function runMigration(): Promise<void> {
    const sql = readMigrationSql();
    // The migration file is a sequence of independent UPDATE statements;
    // Prisma's raw API runs one statement per call, so split on the
    // statement terminators (the file has no semicolons inside strings)
    // and run each — same effect as `prisma migrate deploy`.
    const statements = sql
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement);
    }
}

async function seedTrackAndStage(
    trackId: string,
    stage: string,
    stageStatus: string,
): Promise<void> {
    await prisma.track.create({
        data: {
            id: trackId,
            albumId: id("alb"),
            title: `Track ${trackId}`,
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${trackId}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: stage === "analysis" ? "completed" : "pending",
        },
    });
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage" (id, "trackId", stage, status, source, attempt, retryable, evidence)
         VALUES ($1, $2, $3, $4, $5, 1, true, $6::jsonb)`,
        `${trackId}__${stage}`, trackId, stage, stageStatus, "analyzer",
        JSON.stringify({ probe: "ffmpeg -i", rc: 0 }),
    );
}

async function seedFailure(
    entityType: string,
    entityId: string,
    errorMessage: string,
): Promise<void> {
    await prisma.$executeRawUnsafe(
        `INSERT INTO "EnrichmentFailure"
            ("id", "entityType", "entityId", "entityName", "errorMessage",
             "errorCode", "retryCount", "maxRetries", "firstFailedAt", "lastFailedAt", "resolved", "metadata")
         VALUES ($1, $2, $3, $4, $5, 'STALE', 1, 3, now(), now(), false, $6::jsonb)`,
        `${entityType}:${entityId}`, entityType, entityId, `Name ${entityId}`,
        errorMessage, JSON.stringify({ filePath: "/music/test.flac" }),
    );
}

async function getFailure(entityType: string, entityId: string): Promise<any> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "EnrichmentFailure" WHERE "entityType" = $1 AND "entityId" = $2`,
        entityType, entityId,
    );
    return rows[0];
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "EnrichmentFailure" WHERE "entityId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

async function seedAll(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Stale Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Stale Album", primaryType: "Album" },
    });

    // Stale: the recording stage completed, yet the `track` failure is open.
    await seedTrackAndStage(id("done-rec"), "recording", "done");
    await seedFailure("track", id("done-rec"), "MusicBrainz search found nothing");

    // Stale: analysis completed after the `audio` failure was written.
    await seedTrackAndStage(id("done-aud"), "analysis", "done");
    await seedFailure("audio", id("done-aud"), "Analysis failed: timeout");

    // Stale: embedding completed after the `vibe` failure was written.
    await seedTrackAndStage(id("done-vib"), "embedding", "done");
    await seedFailure("vibe", id("done-vib"), "CLAP embedding failed");

    // NOT stale: the stage is still failed — the failure stays open.
    await seedTrackAndStage(id("still-failed"), "analysis", "failed");
    await seedFailure("audio", id("still-failed"), "decode_frame overrun");

    // NOT stale: no TrackStage record at all for that stage.
    await seedTrackAndStage(id("no-stage"), "recording", "pending");
    await seedFailure("audio", id("no-stage"), "never analysed");

    // NOT stale: an artist failure — not a track stage.
    await seedFailure("artist", id("some-artist"), "Wikidata timeout");

    // Already resolved — must stay resolved with its original timestamp.
    await seedTrackAndStage(id("already"), "recording", "done");
    await prisma.$executeRawUnsafe(
        `INSERT INTO "EnrichmentFailure"
            ("id", "entityType", "entityId", "entityName", "errorMessage",
             "errorCode", "retryCount", "maxRetries", "firstFailedAt", "lastFailedAt", "resolved", "resolvedAt", "metadata")
         VALUES ($1, 'track', $2, 'Already', 'old failure', 'STALE', 1, 3, now(), now(), true, $3::timestamptz, $4::jsonb)`,
        `track:${id("already")}`, id("already"),
        new Date("2026-09-01T00:00:00Z"),
        JSON.stringify({ filePath: "/music/test.flac" }),
    );
}

beforeEach(async () => {
    await wipe();
    await seedAll();
});

afterAll(async () => {
    await wipe();
});

describe("stale EnrichmentFailure backfill", () => {
    it("the migration file exists", () => {
        expect(existsSync(MIGRATION_SQL)).toBe(true);
    });

    it("resolves failures whose track has since completed the stage", async () => {
        await runMigration();

        for (const [entityType, entityId] of [
            ["track", id("done-rec")],
            ["audio", id("done-aud")],
            ["vibe", id("done-vib")],
        ] as const) {
            const failure = await getFailure(entityType, entityId);
            expect(failure.resolved).toBe(true);
            expect(failure.resolvedAt).toBeTruthy();
        }
    });

    it("keeps failures whose stage is not completed", async () => {
        await runMigration();

        expect((await getFailure("audio", id("still-failed"))).resolved).toBe(false);
        expect((await getFailure("audio", id("no-stage"))).resolved).toBe(false);
        expect((await getFailure("artist", id("some-artist"))).resolved).toBe(false);
    });

    it("is idempotent: running it twice produces the same result", async () => {
        await runMigration();
        const first = await getFailure("track", id("done-rec"));
        expect(first.resolved).toBe(true);

        // Second run must not error and must not rewrite anything.
        await expect(runMigration()).resolves.toBeUndefined();
        const second = await getFailure("track", id("done-rec"));
        expect(second.resolved).toBe(true);
        expect(new Date(second.resolvedAt).getTime()).toBe(
            new Date(first.resolvedAt).getTime(),
        );

        // The already-resolved row keeps its original timestamp.
        const already = await getFailure("track", id("already"));
        expect(already.resolved).toBe(true);
        expect(new Date(already.resolvedAt).getTime()).toBe(
            new Date("2026-09-01T00:00:00Z").getTime(),
        );
    });
});