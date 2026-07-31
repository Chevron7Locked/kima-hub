-- Two partial/composite indexes that did not do their job.
--
-- 1. Track_pending_moodtags_idx was UNREACHABLE, not merely unpreferred. Its
--    predicate is `array_length("lastfmTags", 1) IS NULL`, but the query it
--    exists for (unifiedEnrichment's Last.fm tag backlog) goes through Prisma
--    as `{ lastfmTags: { equals: [] } }`, which emits `"lastfmTags" = '{}'`.
--    Those select the SAME rows -- array_length of an empty array is NULL --
--    but the planner cannot prove that implication, so it refused the index
--    even with enable_seqscan and enable_bitmapscan both off.
--
--    Measured on a 300k-row table with a 6k-row backlog:
--      predicate `array_length(...) IS NULL` -> Parallel Seq Scan,  9.174 ms
--      predicate `"lastfmTags" = '{}'`       -> Index Only Scan,    0.409 ms
--
--    So the predicate is changed to the one the ORM actually emits rather than
--    the index being dropped -- the backlog scan is real and wants it.
DROP INDEX IF EXISTS "Track_pending_moodtags_idx";
CREATE INDEX IF NOT EXISTS "Track_pending_moodtags_idx"
    ON "Track" (id) WHERE ("lastfmTags" = '{}');

-- 2. Track_scanStatus_analysisStatus_idx is redundant under real data.
--    The only query with that shape is unifiedEnrichment's vibe backlog,
--    `{ scanStatus: "valid", analysisStatus: "pending" }` -- and scanStatus is
--    'valid' for essentially the whole table, so the leading column adds no
--    selectivity and the planner takes the single-column
--    Track_analysisStatus_idx instead.
--
--    Verified with a realistic distribution (300k rows, all valid, 1% analysis
--    pending): Index Scan using Track_analysisStatus_idx either way, 2.789 ms
--    with the composite present and 2.327 ms without it. It is dead weight to
--    build and maintain on every write.
--
--    (A synthetic distribution where BOTH columns are selective does pick it,
--    which is why this needed measuring against the real shape rather than an
--    invented one.)
DROP INDEX IF EXISTS "Track_scanStatus_analysisStatus_idx";
