-- Re-derive Artist.normalizedName so stored values match how they are queried.
--
-- Two functions named normalizeArtistName existed with different behaviour, on
-- opposite sides of this column: the one in services/artistIdentity.ts WRITES it
-- (via resolveArtist), while the one in utils/artistNormalization.ts was used to
-- QUERY it from ~20 call sites in spotifyImport and discoverWeekly. They
-- disagreed on the ligature fold, because only the writer folded characters that
-- carry no combining mark:
--
--   "MØ"          written "mo"           queried "mø"
--   "Kælan Mikla" written "kaelan mikla" queried "kælan mikla"
--   "Sløtface"    written "slotface"     queried "sløtface"
--
-- Any artist with such a character was therefore unfindable by Spotify import
-- matching and Discover Weekly seeding. The duplicate has been deleted and that
-- module now re-exports the single definition, but rows written by the previous
-- code still hold the unfolded form, so they are re-derived here.
--
-- KNOWN GAP, stated here because this file is what an operator reads while
-- debugging a stuck migrate deploy.
--
-- This statement re-derives the column with Postgres unaccent(). The TypeScript
-- that WRITES the same column at runtime (foldIdentityText in
-- services/artistIdentity.ts) does not use unaccent -- it strips NFD combining
-- marks and then folds a hand-written table of sixteen characters
-- (aeAEoeOEoOssdDthThdDlLhHitT). unaccent() folds a great deal more than those
-- sixteen.
--
-- So the two agree on everything the table covers, which includes every case
-- that prompted this migration, and can disagree on anything else unaccent()
-- touches. Where they disagree, a row re-derived here is written in a form the
-- application's own writer would not produce -- the same unfindable-artist
-- shape this migration exists to fix, for a narrower set of characters.
--
-- Closing it properly means generating the fold from unaccent() rather than
-- maintaining a table by hand, which is what services/pgTextRules.ts does on
-- the rebuild line (commit 4e3ef41b, "derive Postgres text rules from the DB").
-- That commit is NOT part of this release, and neither is the 374-input parity
-- test that ships with it. An earlier revision of this comment cited both as
-- though they were present here; they are not.

CREATE EXTENSION IF NOT EXISTS unaccent;

UPDATE "Artist"
SET "normalizedName" = regexp_replace(
        regexp_replace(lower(unaccent(trim(name))), '\s*&\s*', ' and ', 'g'),
        '\s+', ' ', 'g'
    )
WHERE "normalizedName" IS DISTINCT FROM regexp_replace(
        regexp_replace(lower(unaccent(trim(name))), '\s*&\s*', ' and ', 'g'),
        '\s+', ' ', 'g'
    );
