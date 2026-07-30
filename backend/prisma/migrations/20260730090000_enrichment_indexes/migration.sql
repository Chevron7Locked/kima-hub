-- Indexes for the queries the enrichment orchestrator runs on every cycle.
--
-- The orchestrator ticks continuously and its phase-selection queries had
-- nothing to use, so each tick issued sequential scans of the largest table in
-- the schema against the same connection pool that serves audio streaming.
--
-- These are PARTIAL indexes wherever the predicate is "rows still needing work".
-- That is the right shape here: the index covers only the backlog, so it shrinks
-- toward empty as enrichment completes rather than carrying an entry for every
-- row in the table forever.

-- Mood-tag phase: WHERE lastfmTags is empty AND NOT has '_queued'.
-- array_length() returns NULL for an empty array, which is how "no tags yet" is
-- expressed.
CREATE INDEX IF NOT EXISTS "Track_pending_moodtags_idx"
    ON "Track" ("id")
    WHERE array_length("lastfmTags", 1) IS NULL;

-- The '_queued' sentinel check is a array containment test; GIN is what serves it.
CREATE INDEX IF NOT EXISTS "Track_lastfmTags_gin_idx"
    ON "Track" USING GIN ("lastfmTags");

-- Scan phase: WHERE scanStatus='pending' AND corrupt=false ORDER BY fileModified DESC.
-- Ordering is part of the index so the sort is satisfied by the scan.
CREATE INDEX IF NOT EXISTS "Track_scan_pending_idx"
    ON "Track" ("fileModified" DESC)
    WHERE "scanStatus" = 'pending' AND "corrupt" = false;

-- Analysis phase: WHERE scanStatus='valid' AND analysisStatus='pending'.
-- A composite on (scanStatus, analysisStatus) did not exist; only the two
-- single-column indexes, so the planner could use one and filter with the other.
CREATE INDEX IF NOT EXISTS "Track_scanStatus_analysisStatus_idx"
    ON "Track" ("scanStatus", "analysisStatus");

-- Artist phase: the enrichmentStatus index existed, but the "or stale" leg
-- (lastEnriched < cutoff) had nothing.
CREATE INDEX IF NOT EXISTS "Artist_enrichmentStatus_lastEnriched_idx"
    ON "Artist" ("enrichmentStatus", "lastEnriched");

-- Janitor: deleteMany({ status IN (...), completedAt < cutoff }). `status` was
-- indexed alone, so completedAt was a filter rather than part of the seek.
CREATE INDEX IF NOT EXISTS "DownloadJob_status_completedAt_idx"
    ON "DownloadJob" ("status", "completedAt");

-- Janitor: deleteMany({ processed: true, createdAt < cutoff }). Two separate
-- single-column indexes existed; one composite serves it in a single pass.
CREATE INDEX IF NOT EXISTS "WebhookEvent_processed_createdAt_idx"
    ON "WebhookEvent" ("processed", "createdAt");
