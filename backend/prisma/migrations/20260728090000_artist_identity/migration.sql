-- Artist identity: make duplicate artists impossible at the database level.
--
-- Before this, `mbid` was the only UNIQUE column on Artist and it was NOT NULL,
-- so the scanner fabricated `temp-<timestamp>-<random>` whenever MusicBrainz did
-- not supply one. A guaranteed-unique value on the only unique column means the
-- database could never reject a duplicate: every miss by the name-matching
-- heuristics became a permanent second row for the same artist.
--
-- This adds `identityKey` (casefolded, unaccented, punctuation- and
-- whitespace-stripped) as the real identity, merges existing duplicates into one
-- row each, and only then applies the UNIQUE constraint -- the constraint cannot
-- be added first because the duplicates it forbids are already in the table.

-- 1. New columns, nullable for now so the backfill has somewhere to land.
ALTER TABLE "Artist"
  ADD COLUMN IF NOT EXISTS "identityKey" TEXT,
  ADD COLUMN IF NOT EXISTS "sortName" TEXT;

-- 2. Backfill. Mirrors artistIdentity.ts, INCLUDING its ampersand step: the
--    TypeScript replaces `&` with " and " BEFORE stripping non-alphanumerics
--    (normalizeArtistName), so "Simon & Garfunkel" keys as "simonandgarfunkel",
--    not "simongarfunkel". Dropping the ampersand here instead would write a key
--    the application never computes: resolveArtist would miss the row it just
--    backfilled and insert a duplicate -- exactly what this migration exists to
--    make impossible, and ampersands in band names are common.
--
--    Measured, not assumed. Postgres and the TypeScript were run over the same
--    names; without the inner regexp_replace below, AC&DC, Simon & Garfunkel,
--    Earth, Wind & Fire and Hall & Oates all disagreed, while every accent and
--    ligature case already matched. `unaccent` needs the extension.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Mirrors artistIdentityKey / artistSortName. Two details that are easy to get
-- wrong and were: `&` folds to " and " BEFORE non-alphanumerics are stripped
-- (otherwise "Hall & Oates" backfills as "halloates" while the runtime computes
-- "hallandoates", leaving the stored key unreachable and the duplicate it
-- prevents free to come back), and the name is TRIMMED before the leading
-- article is stripped (otherwise " The Beatles" keeps its article).
-- Identity text rules, defined ONCE so later migrations call them instead of
-- re-typing the expression. Two migrations previously carried hand-copied
-- copies that had already drifted apart, which is the same failure the
-- TypeScript side had before it was consolidated into services/pgTextRules.ts.
--
-- src/services/pgTextRules.ts mirrors these exactly, and the agreement is swept
-- across the whole Basic Multilingual Plane -- if the two disagree by one
-- character, the backfilled key is unreachable from the runtime and the next
-- scan re-creates the duplicate this whole mechanism exists to prevent.
--
-- NOTE trim() is deliberately NOT used: SQL trim(x) is btrim(x, ' '), which
-- strips ASCII spaces only, so a leading tab survives it where JS .trim()
-- removes it.
CREATE OR REPLACE FUNCTION kima_text_trim(v text) RETURNS text AS $$
    SELECT regexp_replace(regexp_replace(v, '^\s+', ''), '\s+$', '');
$$ LANGUAGE sql IMMUTABLE STRICT;

-- Case/accent-insensitive form that KEEPS word boundaries. Stored as
-- Artist.normalizedName.
CREATE OR REPLACE FUNCTION kima_normalized_name(v text) RETURNS text AS $$
    SELECT kima_text_trim(
        regexp_replace(
            regexp_replace(lower(unaccent(kima_text_trim(v))), '\s*&\s*', ' and ', 'g'),
            '\s+', ' ', 'g'
        )
    );
$$ LANGUAGE sql IMMUTABLE STRICT;

-- The dedupe key: normalizedName with every non-alphanumeric removed.
-- `&` folds to " and " BEFORE the strip -- otherwise "Hall & Oates" keys as
-- "halloates" here and "hallandoates" in the runtime.
CREATE OR REPLACE FUNCTION kima_identity_key(v text) RETURNS text AS $$
    SELECT regexp_replace(kima_normalized_name(v), '[^[:alnum:]]', '', 'g');
$$ LANGUAGE sql IMMUTABLE STRICT;

-- Collation-friendly sort value. The name is trimmed BEFORE the leading
-- article is stripped (otherwise " The Beatles" keeps its article), and a name
-- that is nothing but an article falls back to the un-stripped form rather
-- than to empty.
CREATE OR REPLACE FUNCTION kima_sort_name(v text) RETURNS text AS $$
    SELECT CASE WHEN stripped = '' THEN base ELSE stripped END
    FROM (
        SELECT base,
               kima_text_trim(
                   regexp_replace(base, '^(the|a|an|le|la|les|los|las|die|der|das)\s+', '', 'i')
               ) AS stripped
        FROM (SELECT regexp_replace(lower(unaccent(kima_text_trim(v))), '\s+', ' ', 'g') AS base) b
    ) x;
$$ LANGUAGE sql IMMUTABLE STRICT;

UPDATE "Artist"
SET "identityKey" = kima_identity_key(name),
    "sortName"    = kima_sort_name(name)
WHERE "identityKey" IS NULL;

-- An artist whose name is entirely punctuation would collapse to '' and then
-- collide with every other such artist. Fall back to the row id, which is
-- unique by construction.
UPDATE "Artist" SET "identityKey" = id WHERE "identityKey" IS NULL OR "identityKey" = '';
UPDATE "Artist" SET "sortName" = kima_sort_name(name) WHERE "sortName" IS NULL OR "sortName" = '';

-- 3. Choose one surviving row per identityKey. Preference order:
--    a real MusicBrainz id first (the temp- sentinels are not real ids), then
--    the row carrying the most library content, then the lowest id so the
--    result is deterministic.
-- Plain TEMP (not ON COMMIT DROP): psql in autocommit would drop it at the end
-- of this very statement, leaving every step below referencing nothing.
CREATE TEMP TABLE artist_merge_map AS
WITH ranked AS (
    SELECT
        id,
        "identityKey",
        ROW_NUMBER() OVER (
            PARTITION BY "identityKey"
            ORDER BY
                CASE WHEN mbid IS NOT NULL AND mbid NOT LIKE 'temp-%' THEN 0 ELSE 1 END,
                "libraryAlbumCount" DESC,
                "totalTrackCount" DESC,
                id
        ) AS rn
    FROM "Artist"
)
SELECT loser.id AS loser_id, winner.id AS winner_id
FROM ranked loser
JOIN ranked winner
  ON winner."identityKey" = loser."identityKey"
 AND winner.rn = 1
WHERE loser.rn > 1;

-- 4. Repoint every relation onto the winner BEFORE deleting anything. All three
--    cascade on artist delete, so deleting first would destroy the rows we are
--    trying to preserve.

-- Album has no unique on (artistId, title): a plain repoint is safe.
UPDATE "Album" a
SET "artistId" = m.winner_id
FROM artist_merge_map m
WHERE a."artistId" = m.loser_id;

-- OwnedAlbum is keyed (artistId, rgMbid); the winner may already own the same
-- release group. On collision keep the STRONGER provenance rather than whichever
-- row happened to be the winner's: 'native_scan' means the user genuinely owns
-- it, and cleanup-lidarr keys artist protection on that exact value, so silently
-- downgrading it to 'discovery_liked' would make an artist eligible for deletion
-- that should have been protected.
-- GROUP BY is required, not cosmetic: several loser artists can map to ONE
-- winner, and an INSERT proposing the same (artistId, rgMbid) twice makes
-- ON CONFLICT DO UPDATE abort the whole migration with SQLSTATE 21000 -- after
-- Album rows have already been repointed. Collapse first, keeping the strongest
-- provenance across the rows being merged.
INSERT INTO "OwnedAlbum" ("artistId", "rgMbid", "source")
SELECT
    m.winner_id,
    o."rgMbid",
    CASE WHEN bool_or(o."source" = 'native_scan') THEN 'native_scan'
         ELSE min(o."source") END
FROM "OwnedAlbum" o
JOIN artist_merge_map m ON o."artistId" = m.loser_id
GROUP BY m.winner_id, o."rgMbid"
ON CONFLICT ("artistId", "rgMbid") DO UPDATE
SET source = CASE
        WHEN "OwnedAlbum".source = 'native_scan' OR EXCLUDED.source = 'native_scan'
            THEN 'native_scan'
        ELSE "OwnedAlbum".source
    END;

DELETE FROM "OwnedAlbum" o
USING artist_merge_map m
WHERE o."artistId" = m.loser_id;

-- SimilarArtist is keyed (fromArtistId, toArtistId) and both ends can point at
-- a loser. Rebuild the edges, drop duplicates, and drop self-edges that appear
-- when two rows that referenced each other turn out to be the same artist.
INSERT INTO "SimilarArtist" ("fromArtistId", "toArtistId", "weight")
SELECT
    COALESCE(mf.winner_id, s."fromArtistId"),
    COALESCE(mt.winner_id, s."toArtistId"),
    s."weight"
FROM "SimilarArtist" s
LEFT JOIN artist_merge_map mf ON s."fromArtistId" = mf.loser_id
LEFT JOIN artist_merge_map mt ON s."toArtistId"   = mt.loser_id
WHERE (mf.loser_id IS NOT NULL OR mt.loser_id IS NOT NULL)
  AND COALESCE(mf.winner_id, s."fromArtistId") <> COALESCE(mt.winner_id, s."toArtistId")
ON CONFLICT ("fromArtistId", "toArtistId") DO NOTHING;

DELETE FROM "SimilarArtist" s
USING artist_merge_map m
WHERE s."fromArtistId" = m.loser_id OR s."toArtistId" = m.loser_id;

-- 5. Losers are now unreferenced.
DELETE FROM "Artist" a USING artist_merge_map m WHERE a.id = m.loser_id;

-- 6. Retire the temp- sentinel. mbid becomes nullable and "unknown" is
--    expressed as NULL, which is what it always meant. Postgres treats NULLs as
--    distinct under a UNIQUE constraint, so many artists may lack an mbid.
ALTER TABLE "Artist" ALTER COLUMN "mbid" DROP NOT NULL;
UPDATE "Artist" SET mbid = NULL WHERE mbid LIKE 'temp-%';

-- 7. Now the constraints can hold.
UPDATE "Artist" SET "sortName" = '' WHERE "sortName" IS NULL;
ALTER TABLE "Artist" ALTER COLUMN "identityKey" SET NOT NULL;
ALTER TABLE "Artist" ALTER COLUMN "sortName" SET NOT NULL;
ALTER TABLE "Artist" ALTER COLUMN "sortName" SET DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS "Artist_identityKey_key" ON "Artist"("identityKey");
CREATE INDEX IF NOT EXISTS "Artist_sortName_idx" ON "Artist"("sortName");

DROP TABLE IF EXISTS artist_merge_map;
