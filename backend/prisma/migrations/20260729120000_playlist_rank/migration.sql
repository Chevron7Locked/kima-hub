-- Playlist ordering: fractional ranks in ONE key space.
--
-- Order was an integer `sort` with no uniqueness, held in TWO independent
-- counters -- PlaylistItem.sort and PlaylistPendingTrack.sort -- that the read
-- path merged by comparing them to each other. A single reorder renumbered items
-- to 0..n-1, colliding head-on with the pending tracks' original Spotify
-- positions, which is why imported playlists displayed scrambled.
--
-- Ranks are base-62 strings ordered by plain string comparison, drawn from one
-- shared space across both tables, so merging them by rank is meaningful and a
-- move rewrites exactly one row.
--
-- The backfill preserves the CURRENT displayed order (both tables interleaved by
-- their existing sort, exactly as the read path merged them). It cannot recover
-- the true original order of an already-scrambled import -- that information was
-- destroyed when the reorder renumbered items -- so this makes the order stable
-- from here rather than retroactively correct.

ALTER TABLE "PlaylistItem"         ADD COLUMN IF NOT EXISTS "rank" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlaylistPendingTrack" ADD COLUMN IF NOT EXISTS "rank" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Playlist" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Base-62 rank from a zero-based position, matching lexoRank.ts's alphabet
-- ("0-9A-Za-z"). Two characters cover 3844 positions; anything beyond that gets
-- three. Positions are spread with a +1 offset so a later prepend has room.
CREATE OR REPLACE FUNCTION kima_rank_from_position(pos BIGINT) RETURNS TEXT AS $$
DECLARE
    alphabet CONSTANT TEXT := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    v BIGINT := pos + 1;
    out TEXT := '';
BEGIN
    -- Fixed 3 characters keeps every key the same length, so string ordering
    -- matches numeric ordering without needing padding logic at read time.
    out := substr(alphabet, ((v / 3844) % 62)::INT + 1, 1)
        || substr(alphabet, ((v / 62)   % 62)::INT + 1, 1)
        || substr(alphabet, ( v         % 62)::INT + 1, 1);
    RETURN out;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Interleave both tables per playlist by their existing sort, then assign ranks
-- in that merged order. `kind` breaks ties deterministically when an item and a
-- pending track share a sort value -- which is precisely the collision this
-- migration exists to remove.
CREATE TEMP TABLE playlist_rank_map AS
WITH merged AS (
    SELECT id, 'item'    AS kind, "playlistId", "sort" FROM "PlaylistItem"
    UNION ALL
    SELECT id, 'pending' AS kind, "playlistId", "sort" FROM "PlaylistPendingTrack"
)
SELECT
    id,
    kind,
    ROW_NUMBER() OVER (PARTITION BY "playlistId" ORDER BY "sort", kind, id) - 1 AS pos
FROM merged;

UPDATE "PlaylistItem" pi
SET "rank" = kima_rank_from_position(m.pos)
FROM playlist_rank_map m
WHERE m.id = pi.id AND m.kind = 'item';

UPDATE "PlaylistPendingTrack" pt
SET "rank" = kima_rank_from_position(m.pos)
FROM playlist_rank_map m
WHERE m.id = pt.id AND m.kind = 'pending';

DROP TABLE IF EXISTS playlist_rank_map;

DROP FUNCTION IF EXISTS kima_rank_from_position(BIGINT);

-- A rank must be unique within a playlist: that is the constraint whose absence
-- allowed the duplicate positions in the first place.
CREATE UNIQUE INDEX IF NOT EXISTS "PlaylistItem_playlistId_rank_key"
    ON "PlaylistItem"("playlistId", "rank");
CREATE INDEX IF NOT EXISTS "PlaylistItem_playlistId_rank_idx"
    ON "PlaylistItem"("playlistId", "rank");
CREATE INDEX IF NOT EXISTS "PlaylistPendingTrack_playlistId_rank_idx"
    ON "PlaylistPendingTrack"("playlistId", "rank");
CREATE INDEX IF NOT EXISTS "Playlist_isPublic_idx" ON "Playlist"("isPublic");

DROP INDEX IF EXISTS "PlaylistItem_playlistId_sort_idx";
