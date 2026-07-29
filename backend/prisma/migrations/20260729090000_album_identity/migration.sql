-- Album identity: make duplicate albums impossible under one artist.
--
-- Album lookup matched `title` raw and un-normalised, so "Abbey Road",
-- "abbey road" and "Abbey Road (2019 Remaster)" became three rows under the same
-- artist. `Album` models a MusicBrainz RELEASE GROUP, and those are three
-- releases of ONE release group, so they must be one row.
--
-- SCOPE: this does NOT retire the `temp-<ts>-<random>` sentinel on rgMbid, even
-- though that is the same defect retired on Artist.mbid. OwnedAlbum and
-- DiscoveryAlbum reference albums by the rgMbid STRING VALUE, not by a foreign
-- key, so nulling it would dangle every ownership row. Those tables must move to
-- an albumId FK first.

-- 1. New column, nullable during backfill.
ALTER TABLE "Album" ADD COLUMN IF NOT EXISTS "identityKey" TEXT;

CREATE EXTENSION IF NOT EXISTS unaccent;

-- 2. Backfill. Mirrors albumIdentityKey() in albumIdentity.ts: strip edition and
--    version markers, then lower + unaccent + drop everything non-alphanumeric.
--    The pattern list is kept in step with stripAlbumEdition().
UPDATE "Album"
SET "identityKey" = regexp_replace(
        lower(unaccent(
            regexp_replace(
                title,
                '\s*[\(\[][^\)\]]*(deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|soundtrack|super deluxe|explicit|clean|mono|stereo|remix|live|acoustic|unplugged|session|recording|import|japan|uk|us)[^\)\]]*[\)\]]\s*',
                '', 'gi'
            )
        )),
        '[^[:alnum:]]', '', 'g'
    )
WHERE "identityKey" IS NULL;

-- A title that collapses to nothing (punctuation-only, e.g. "( )") would collide
-- with every other such album under the same artist. Fall back to the row id.
UPDATE "Album" SET "identityKey" = id WHERE "identityKey" IS NULL OR "identityKey" = '';

-- 3. Pick one surviving row per (artistId, identityKey). Preference: a real
--    release-group id over a temp- sentinel, then the row with the most tracks,
--    then the lowest id for determinism.
CREATE TEMP TABLE album_merge_map AS
WITH ranked AS (
    SELECT
        a.id,
        a."artistId",
        a."identityKey",
        a."rgMbid",
        ROW_NUMBER() OVER (
            PARTITION BY a."artistId", a."identityKey"
            ORDER BY
                CASE WHEN a."rgMbid" NOT LIKE 'temp-%' THEN 0 ELSE 1 END,
                (SELECT count(*) FROM "Track" t WHERE t."albumId" = a.id) DESC,
                a.id
        ) AS rn
    FROM "Album" a
)
SELECT
    loser.id      AS loser_id,
    winner.id     AS winner_id,
    loser."rgMbid"  AS loser_rgmbid,
    winner."rgMbid" AS winner_rgmbid
FROM ranked loser
JOIN ranked winner
  ON winner."artistId"    = loser."artistId"
 AND winner."identityKey" = loser."identityKey"
 AND winner.rn = 1
WHERE loser.rn > 1;

-- 4. Move tracks onto the winner BEFORE deleting: Track cascades on album delete,
--    so deleting first would destroy the audio rows we are preserving. Track has
--    no unique constraint on (albumId, ...), so a plain repoint cannot collide.
UPDATE "Track" t
SET "albumId" = m.winner_id
FROM album_merge_map m
WHERE t."albumId" = m.loser_id;

-- 5. OwnedAlbum and DiscoveryAlbum key albums by the rgMbid STRING. Repoint those
--    references from the loser's sentinel onto the winner's, so ownership follows
--    the surviving album instead of dangling. OwnedAlbum is keyed
--    (artistId, rgMbid), so a collision is possible; keep the stronger provenance.
-- GROUP BY is required, not cosmetic: several losers can map to ONE winner, and
-- an INSERT proposing the same (artistId, rgMbid) twice makes ON CONFLICT DO
-- UPDATE fail with "cannot affect row a second time". Collapse first, keeping
-- the strongest provenance across the rows being merged.
INSERT INTO "OwnedAlbum" ("artistId", "rgMbid", "source")
SELECT
    o."artistId",
    m.winner_rgmbid,
    CASE WHEN bool_or(o."source" = 'native_scan') THEN 'native_scan'
         ELSE min(o."source") END
FROM "OwnedAlbum" o
JOIN album_merge_map m ON o."rgMbid" = m.loser_rgmbid
GROUP BY o."artistId", m.winner_rgmbid
ON CONFLICT ("artistId", "rgMbid") DO UPDATE
SET source = CASE
        WHEN "OwnedAlbum".source = 'native_scan' OR EXCLUDED.source = 'native_scan'
            THEN 'native_scan'
        ELSE "OwnedAlbum".source
    END;

DELETE FROM "OwnedAlbum" o
USING album_merge_map m
WHERE o."rgMbid" = m.loser_rgmbid;

UPDATE "DiscoveryAlbum" d
SET "rgMbid" = m.winner_rgmbid
FROM album_merge_map m
WHERE d."rgMbid" = m.loser_rgmbid
  AND NOT EXISTS (
      SELECT 1 FROM "DiscoveryAlbum" x
      WHERE x."userId" = d."userId"
        AND x."weekStartDate" = d."weekStartDate"
        AND x."rgMbid" = m.winner_rgmbid
  );

DELETE FROM "DiscoveryAlbum" d
USING album_merge_map m
WHERE d."rgMbid" = m.loser_rgmbid;

-- 6. Losers are now unreferenced.
DELETE FROM "Album" a USING album_merge_map m WHERE a.id = m.loser_id;

-- 7. Constraints can hold now.
ALTER TABLE "Album" ALTER COLUMN "identityKey" SET NOT NULL;
ALTER TABLE "Album" ALTER COLUMN "identityKey" SET DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS "Album_artistId_identityKey_key"
    ON "Album"("artistId", "identityKey");

DROP TABLE IF EXISTS album_merge_map;
