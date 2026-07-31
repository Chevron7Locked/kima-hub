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
-- Mirrors albumIdentityKey, which calls stripAlbumEdition. That function runs
-- FOUR passes; an earlier version of this backfill ran only the first, so
-- "Abbey Road - 2019 Remaster" and "Abbey Road (1969)" backfilled with the
-- marker intact while the runtime strips it -- the stored key was unreachable
-- and the duplicate came back on the next scan. All four passes, in order:
--   1. parenthetical edition markers
--   2. bracketed edition markers
--   3. trailing dash/colon content carrying an edition keyword
--   4. a trailing bare (YYYY)
-- then lower + unaccent + drop everything non-alphanumeric.
-- Album identity, mirroring services/albumIdentity.ts. Edition markers are
-- stripped BEFORE the key is built so every pressing of a release group lands
-- on one row. stripAlbumEdition runs FOUR passes and so does this: an earlier
-- version of this backfill ran only the bracketed-marker pass, which left
-- "Abbey Road - 2019 Remaster" keyed apart from "Abbey Road".
CREATE OR REPLACE FUNCTION kima_album_edition_strip(v text) RETURNS text AS $$
    SELECT regexp_replace(
        regexp_replace(
            regexp_replace(
                regexp_replace(v, '\s*\([^)]*(deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|soundtrack|motion picture|super deluxe|explicit|clean|mono|stereo|remix|live|acoustic|unplugged|sessions?|recording|import|japan|uk|us)[^)]*\)\s*', '', 'gi'),
                '\s*\[[^\]]*(deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|soundtrack|motion picture|super deluxe|explicit|clean|mono|stereo|remix|live|acoustic|unplugged|sessions?|recording|import|japan|uk|us)[^\]]*\]\s*', '', 'gi'
            ),
            '\s*[-–—:]\s*(\d{4}\s+)?(deluxe|remaster|expanded|anniversary|bonus|special|limited|collector|platinum|edition|version|original|soundtrack|motion picture|super deluxe|explicit|clean|mono|stereo|remix|live|acoustic|unplugged|sessions?|recording|import|japan|uk|us).*$', '', 'i'
        ),
        '\s*\(\d{4}\)\s*$', '', 'g'
    );
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION kima_album_identity_key(v text) RETURNS text AS $$
    SELECT regexp_replace(
        lower(unaccent(kima_album_edition_strip(kima_text_trim(v)))),
        '[^[:alnum:]]', '', 'g'
    );
$$ LANGUAGE sql IMMUTABLE STRICT;

UPDATE "Album"
SET "identityKey" = kima_album_identity_key(title)
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

-- DiscoveryAlbum is keyed (userId, weekStartDate, rgMbid), so the repoint needs
-- the same collapse OwnedAlbum got above -- for a subtler reason.
--
-- The NOT EXISTS below only sees the statement's SNAPSHOT. Two loser rows in
-- ONE user's week that map to the SAME winner therefore both pass it: neither
-- can see the other being repointed by this same statement. Both then land on
-- (user, week, winner) and the unique index rejects the whole statement with
-- "duplicate key value violates unique constraint". That is not a corner case
-- -- two editions of one album turning up in a single discovery week is
-- precisely the duplication this migration exists to collapse.
--
-- Reproduced on Postgres 16 before fixing, and the fixture below re-verified
-- after: one user with two losers in one week, plus a second user, plus a row
-- whose winner already exists in a DIFFERENT week.
--
-- The ctid clause picks exactly ONE row per (user, week, winner) to carry the
-- rename. The siblings fall through to the DELETE immediately below, which
-- removes every remaining loser row anyway -- so nothing is lost that the
-- migration was not already discarding.
UPDATE "DiscoveryAlbum" d
SET "rgMbid" = m.winner_rgmbid
FROM album_merge_map m
WHERE d."rgMbid" = m.loser_rgmbid
  AND NOT EXISTS (
      SELECT 1 FROM "DiscoveryAlbum" x
      WHERE x."userId" = d."userId"
        AND x."weekStartDate" = d."weekStartDate"
        AND x."rgMbid" = m.winner_rgmbid
  )
  AND d.ctid = (
      SELECT d2.ctid
      FROM "DiscoveryAlbum" d2
      JOIN album_merge_map m2 ON d2."rgMbid" = m2.loser_rgmbid
      WHERE d2."userId" = d."userId"
        AND d2."weekStartDate" = d."weekStartDate"
        AND m2.winner_rgmbid = m.winner_rgmbid
      ORDER BY d2.ctid
      LIMIT 1
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
