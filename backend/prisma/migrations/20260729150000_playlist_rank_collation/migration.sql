-- Force byte-order comparison on playlist rank columns.
--
-- The ranks are base-62 over "0-9A-Za-z" and the whole design assumes a string
-- comparison in Postgres matches one in JavaScript. Under the database's default
-- locale collation it does NOT:
--
--   postgres default : 'F' < 'j' < 'U'
--   postgres COLLATE C: 'F' < 'U' < 'j'
--   javascript        : 'F' < 'U' < 'j'
--
-- So `ORDER BY rank` returned a different order than the service's own
-- comparisons, and `rank > $before` selected the wrong neighbour when allocating
-- a rank -- the same class of silent inconsistency the fractional ranks were
-- introduced to remove.
--
-- COLLATE "C" is byte order, which is what the alphabet was chosen for. It also
-- removes the dependency on the deployment's locale entirely, so this cannot
-- drift with a different Postgres image. Note Prisma has no schema-level
-- collation attribute for Postgres, so this lives in SQL only.
--
-- The indexes are dropped first: a btree's physical order is a property of the
-- column collation, so they must be rebuilt to remain valid.

DROP INDEX IF EXISTS "PlaylistItem_playlistId_rank_key";
DROP INDEX IF EXISTS "PlaylistItem_playlistId_rank_idx";
DROP INDEX IF EXISTS "PlaylistPendingTrack_playlistId_rank_idx";

ALTER TABLE "PlaylistItem"
    ALTER COLUMN "rank" TYPE TEXT COLLATE "C";

ALTER TABLE "PlaylistPendingTrack"
    ALTER COLUMN "rank" TYPE TEXT COLLATE "C";

CREATE UNIQUE INDEX "PlaylistItem_playlistId_rank_key"
    ON "PlaylistItem"("playlistId", "rank");
CREATE INDEX "PlaylistItem_playlistId_rank_idx"
    ON "PlaylistItem"("playlistId", "rank");
CREATE INDEX "PlaylistPendingTrack_playlistId_rank_idx"
    ON "PlaylistPendingTrack"("playlistId", "rank");
