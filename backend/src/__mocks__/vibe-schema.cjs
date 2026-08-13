/**
 * Idempotently creates the minimal `vibe` schema/tables the social
 * integration tests read: `vibe.fused_track`, `vibe.track_display`.
 *
 * These are normally created and written by the Python vibe-engine, not by
 * Prisma -- see prisma/migrations/20260801160000_vibe_schema_namespace/
 * migration.sql's comment for why Prisma deliberately can't own them (it
 * would propose DROPping every fused vector on a plain `migrate dev`/
 * `db push`). That migration DOES create the empty `vibe` SCHEMA namespace,
 * but on a freshly-migrated database none of the vibe-engine's own tables
 * exist inside it -- only a real vibe-engine run, or this bootstrap, puts
 * them there.
 *
 * Without this, any test that queries `vibe.*` (directly, or transitively
 * through a service like `vibeProfileService`/`trackDisplay.ts`) fails with
 * "relation does not exist" on a fresh database -- a reason that isn't a
 * code defect, just a missing table these tests don't actually need the
 * real vibe-engine's exact schema/data for. The shape here is deliberately
 * minimal: only the two tables and columns these tests actually read.
 */
async function ensureVibeSchema(prisma) {
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS vibe`);
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS vibe.fused_track (track_id text PRIMARY KEY, v3 vector(514))`,
    );
    await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS vibe.track_display (track_id text PRIMARY KEY,
            valence real, arousal real, happy real, sad real, relaxed real, party real, aggressive real)`,
    );
}

module.exports = { ensureVibeSchema };
