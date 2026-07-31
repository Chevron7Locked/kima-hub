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
-- unaccent() folds these the same way the TypeScript does -- that equivalence is
-- asserted by tests over a character set, and is the same property the artist
-- and album identity backfills depend on.

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
