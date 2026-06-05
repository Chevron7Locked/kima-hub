-- Phase G: Double Metaphone phonetic matching for ARTIST search (last resort).
--
-- This is a RARE last-resort fallback used only when both the unified FTS +
-- trigram search and (it would otherwise reach) the LIKE fallback turn up
-- nothing. It catches phonetic spellings that trigram similarity misses, e.g.
-- "ke$ha" -> "Kesha", "deadmau5" -> a "deadmouse"-ish artist. Album/track
-- phonetic matching is deliberately NOT added: it is overkill there and would
-- add noise; artist names are the high-value case.
--
-- fuzzystrmatch provides dmetaphone(). dmetaphone is IMMUTABLE, so it can back
-- a functional btree index, making the equality lookup
--   dmetaphone(name) = dmetaphone(<query>)
-- cheap even though it is only hit on the rare empty-result path. We use
-- dmetaphone (not metaphone) because metaphone requires a length argument and
-- is not directly indexable the same way.
--
-- Plain CREATE INDEX (not CONCURRENTLY) is used because Prisma runs each
-- migration in a transaction; the Artist table is small enough that the brief
-- lock is fine.

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

CREATE INDEX IF NOT EXISTS "Artist_name_dmetaphone_idx"
  ON "Artist" (dmetaphone(name));
