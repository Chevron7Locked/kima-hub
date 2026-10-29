import { prisma } from "../../utils/db";
import { seedEmbedding } from "./embeddingFixtures";

export interface PutStageOptions {
    source?: string;
    attempt?: number;
    retryable?: boolean;
    nextRetryAt?: Date | null;
    failureClass?: string;
    evidence?: Record<string, unknown>;
    /** Stamp a `done` record as decided by the engine. */
    decided?: boolean;
    /** Leave a record that is not `done` without an error code, message or class. Default true: it carries a seeded error. */
    seedError?: boolean;
}

/**
 * Writes one TrackStage record, replacing any existing record for the track
 * and stage. A record that is not `done` carries a seeded error unless
 * `seedError` is false; a `done` record never does.
 */
export async function putStage(
    trackId: string,
    stage: string,
    status: string,
    opts: PutStageOptions = {},
): Promise<void> {
    const noError = status === "done" || opts.seedError === false;
    const done = status === "done";
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, "lastErrorCode",
             "lastErrorMessage", "failureClass", retryable, "nextRetryAt", evidence,
             "decidedAt", "decidedBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
         ON CONFLICT ("trackId", stage) DO UPDATE
            SET status = EXCLUDED.status,
                source = EXCLUDED.source,
                attempt = EXCLUDED.attempt,
                "lastErrorCode" = EXCLUDED."lastErrorCode",
                "lastErrorMessage" = EXCLUDED."lastErrorMessage",
                "failureClass" = EXCLUDED."failureClass",
                retryable = EXCLUDED.retryable,
                "nextRetryAt" = EXCLUDED."nextRetryAt",
                evidence = EXCLUDED.evidence,
                "decidedAt" = EXCLUDED."decidedAt",
                "decidedBy" = EXCLUDED."decidedBy"`,
        `${trackId}__${stage}`, trackId, stage, status,
        opts.source ?? "analyzer", opts.attempt ?? 0,
        noError ? null : "TEST_SEED",
        noError ? null : "seeded by test",
        noError ? null : opts.failureClass ?? "INCONCLUSIVE",
        opts.retryable ?? true, opts.nextRetryAt ?? null,
        JSON.stringify(opts.evidence ?? { probe: "ffmpeg -i", rc: 1 }),
        done && opts.decided ? new Date() : null,
        done && opts.decided ? "engine" : null,
    );
}

/** Deletes every row a spec seeded under `prefix_`, children before parents. `_` is escaped so it matches only itself. */
export async function deleteSeededRows(prefix: string): Promise<void> {
    const like = `${prefix.replace(/[\\%_]/g, "\\$&")}\\_%`;
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, like);
    await prisma.$executeRawUnsafe(`DELETE FROM "track_embeddings" WHERE track_id LIKE $1`, like);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, like);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, like);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, like);
}

/** Creates the artist and album (`<prefix>_art`, `<prefix>_alb`) the seeded tracks hang off. */
export async function seedArtistAndAlbum(prefix: string, label: string): Promise<void> {
    await prisma.artist.create({
        data: { id: `${prefix}_art`, name: `${label} Artist`, identityKey: `${prefix}_a` },
    });
    await prisma.album.create({
        data: {
            id: `${prefix}_alb`,
            rgMbid: `${prefix}_rg`,
            artistId: `${prefix}_art`,
            title: `${label} Album`,
            primaryType: "Album",
        },
    });
}

/** Stores a sound vector for the track; its values only need to be non-degenerate. */
export async function seedPatternEmbedding(trackId: string): Promise<void> {
    await seedEmbedding(trackId, `[${Array.from({ length: 512 }, (_, i) => (i % 7) / 7).join(",")}]`);
}
