-- Audiobook.sortName: the same treatment Artist (20260728090000_artist_identity)
-- and Album (20260807190000_album_sort_name) got. `GET /audiobooks` orders on
-- the raw `title`, so "The Hobbit" files under T.
--
-- Reuses kima_sort_name unchanged -- generic over text already, no new
-- function needed.
--
-- Unlike Album, there is no displayTitle/hasUserOverrides equivalent here
-- (checked against the live schema before writing this migration -- Audiobook
-- has no override field of any kind), so there is no effective-title
-- complication: the backfill and both write sites
-- (services/audiobookCache.ts, services/audiobookshelf.ts) derive sortName
-- from `title` alone.

ALTER TABLE "Audiobook" ADD COLUMN IF NOT EXISTS "sortName" TEXT;

UPDATE "Audiobook"
SET "sortName" = kima_sort_name(title)
WHERE "sortName" IS NULL OR "sortName" = '';

ALTER TABLE "Audiobook" ALTER COLUMN "sortName" SET NOT NULL;
ALTER TABLE "Audiobook" ALTER COLUMN "sortName" SET DEFAULT '';

CREATE INDEX IF NOT EXISTS "Audiobook_sortName_idx" ON "Audiobook"("sortName");
