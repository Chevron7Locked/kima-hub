-- A play recorded under the listen rule is a listen by construction; the history audit never judges it a skip.
ALTER TABLE "Play" ADD COLUMN "heard" BOOLEAN NOT NULL DEFAULT false;

-- Every play since this install moved to 1.11 was recorded under that rule. "playedAt" holds UTC without a zone;
-- it is read as UTC, so a database whose sessions run in another zone compares the same instants.
-- Guarded for shadow and fresh databases, where _prisma_migrations does not exist yet (the pattern
-- established by 20260916000000_resolve_soulseek_fallback_split); the backfill only ever concerns a
-- database with migration history, and a database without history has no plays to backfill.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '_prisma_migrations'
    ) THEN
        UPDATE "Play" SET "heard" = true
        WHERE ("playedAt" AT TIME ZONE 'UTC') >= (
            SELECT min("finished_at") FROM "_prisma_migrations"
            WHERE "migration_name" >= '20260825010000_play_audit_ignore' AND "finished_at" IS NOT NULL
        );
    ELSE
        RAISE NOTICE '[play-heard] _prisma_migrations absent; nothing to backfill';
    END IF;
END $$;
