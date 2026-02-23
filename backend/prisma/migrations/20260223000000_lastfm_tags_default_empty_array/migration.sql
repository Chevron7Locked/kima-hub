-- Fix NULL lastfmTags so the enrichment orchestrator can find them.
-- New tracks were created with NULL because no default was set on the column.
-- The mood-tags phase queries `= '{}'` which never matches NULL in PostgreSQL.

-- Fix existing rows
UPDATE "Track" SET "lastfmTags" = '{}' WHERE "lastfmTags" IS NULL;

-- Prevent future NULLs
ALTER TABLE "Track" ALTER COLUMN "lastfmTags" SET DEFAULT '{}';
