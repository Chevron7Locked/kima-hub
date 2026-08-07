-- Album.sortName: the same treatment Artist got in 20260728090000_artist_identity.
-- Reuses kima_sort_name -- generic over text already, and measured directly
-- against real album titles in the live image, so it needs no changes and no
-- new function.
--
-- The backfill derives from the EFFECTIVE title -- displayTitle when a user
-- has set one, title otherwise -- not from the canonical title alone.
-- Deriving from the canonical field alone is exactly the defect shipped for
-- Artist in be01529 and fixed in 23a2283: an override moves independently of
-- a sort value derived only from the field it overrides, so an album with a
-- display override would file under the title the override was meant to
-- replace. Every write site that sets displayTitle keeps sortName in sync
-- going forward (routes/enrichment.ts, albumIdentity.ts); this backfill only
-- covers rows that already exist.

ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "sortName" TEXT;

UPDATE "Album"
SET "sortName" = kima_sort_name(COALESCE(NULLIF("displayTitle", ''), title))
WHERE "sortName" IS NULL OR "sortName" = '';

ALTER TABLE "Album" ALTER COLUMN "sortName" SET NOT NULL;
ALTER TABLE "Album" ALTER COLUMN "sortName" SET DEFAULT '';

CREATE INDEX IF NOT EXISTS "Album_sortName_idx" ON "Album"("sortName");

-- Defensive Artist.sortName re-derivation, carried in this migration rather
-- than a separate one since it is the same class of correction. The
-- write-time fix (23a2283) keeps sortName in sync with displayName going
-- forward; this catches any row that was already stale before that fix
-- landed. Verified directly against this database: zero Artist rows have a
-- displayName whose sortName disagrees with it. Production was never
-- queried, so this is not asserted clean there -- the WHERE clause makes the
-- statement a no-op wherever it already is, and a real fix wherever it is
-- not.
UPDATE "Artist"
SET "sortName" = kima_sort_name(COALESCE(NULLIF("displayName", ''), name))
WHERE "sortName" IS DISTINCT FROM kima_sort_name(COALESCE(NULLIF("displayName", ''), name));
