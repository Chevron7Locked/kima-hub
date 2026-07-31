-- Two gaps found by the wiring audit.
--
-- 1. Subsonic savePlayQueue parsed `position` and then discarded it (`void
--    position`), because the table it was consolidated onto had no column for
--    it. Both readers hardcoded `"@_position": 0`. The implementation it
--    replaced did persist it. Symfonium/DSub/Amperfy use it to resume
--    mid-track across devices, so it always resumed from the start.
--    `changedBy` has the same shape of problem: it was echoed back from the
--    REQUESTING client, so a queue always looked self-authored and a device
--    could never tell another one had changed it.
ALTER TABLE "PlaybackState" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PlaybackState" ADD COLUMN IF NOT EXISTS "changedBy" TEXT;

-- 2. PlaylistItem and PlaylistPendingTrack share ONE ordering space, but only
--    PlaylistItem had a unique index on (playlistId, rank). Give the pending
--    table the same guarantee.
--
--    NOTE this closes the within-table case only. A pending track and an item
--    can still be allocated the same rank, because no per-table constraint can
--    see across the two; that is why services/playlistService.ts computes the
--    next rank over BOTH tables rather than trusting the index.
--
--    Existing collisions have to go before the index can be built. Rows are
--    re-ranked deterministically by (rank, sort, id) so a replay is stable,
--    and only within the groups that actually collide.
WITH dupes AS (
    SELECT id,
           row_number() OVER (PARTITION BY "playlistId", "rank" ORDER BY "sort", id) AS n,
           "playlistId", "rank"
    FROM "PlaylistPendingTrack"
)
UPDATE "PlaylistPendingTrack" pt
SET "rank" = d."rank" || repeat('0', (d.n - 1)::int) || chr((48 + (d.n % 10))::int)
FROM dupes d
WHERE pt.id = d.id AND d.n > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "PlaylistPendingTrack_playlistId_rank_key"
    ON "PlaylistPendingTrack"("playlistId", "rank");
