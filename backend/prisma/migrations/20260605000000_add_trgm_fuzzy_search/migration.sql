-- Trigram fuzzy search support.
--
-- The existing full-text search (searchVector + to_tsquery) has no typo
-- tolerance: e.g. "metalica" matches nothing while "metallica" matches. This
-- adds pg_trgm so the search service can fall back to trigram similarity when
-- FTS returns no rows, catching typos and Unicode-punctuation variants
-- (e.g. "blink-182" vs the stored U+2010 "blink‐182").
--
-- These GIN trigram indexes are additive: the existing searchVector triggers
-- and GIN indexes are untouched, so no reindex/backfill is required. Plain
-- CREATE INDEX (not CONCURRENTLY) is used because Prisma runs each migration
-- in a transaction; table sizes are small enough that the brief lock is fine.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Artist_name_trgm_idx"
  ON "Artist" USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Album_title_trgm_idx"
  ON "Album" USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Track_title_trgm_idx"
  ON "Track" USING GIN (title gin_trgm_ops);
