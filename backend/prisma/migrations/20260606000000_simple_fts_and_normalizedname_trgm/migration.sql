-- Switch MUSIC search vectors from the 'english' to the 'simple' text-search config.
--
-- The 'english' config stems words and strips stopwords, which mangles band
-- names made of common words: "The The" -> empty, "Yes" survives but "The"
-- vanishes, "Was (Not Was)" loses "Was"/"Not". 'simple' lowercases and tokenises
-- without stemming or a stopword list, so these stay searchable. We replace the
-- trigger functions (the BEFORE INSERT/UPDATE triggers themselves are unchanged
-- and keep pointing at the same function names) and backfill existing rows.
--
-- The query side (backend/src/services/search.ts searchArtists/searchAlbums/
-- searchTracks) is switched to to_tsquery('simple', ...) in the same change so
-- the stored vector and the query config stay consistent per table. Podcast/
-- Episode/Audiobook vectors and queries remain on 'english' (prose-like text
-- benefits from stemming) and are untouched here.
--
-- We also add a pg_trgm GIN index on Artist.normalizedName so the search
-- service can match accent/&-folded queries: e.g. "of mice and men" against the
-- stored "Of Mice & Men" whose normalizedName is "of mice and men".
-- pg_trgm was already created by migration 20260605000000_add_trgm_fuzzy_search,
-- so no CREATE EXTENSION is needed here.
--
-- Plain CREATE INDEX (not CONCURRENTLY) is used because Prisma runs each
-- migration in a transaction; the table is small enough that the brief lock is
-- fine.

-- ============================================================================
-- ARTIST SEARCH VECTOR FUNCTION (simple config)
-- ============================================================================
CREATE OR REPLACE FUNCTION artist_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- ============================================================================
-- ALBUM SEARCH VECTOR FUNCTION (simple config)
-- ============================================================================
CREATE OR REPLACE FUNCTION album_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple', COALESCE(NEW.title, '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRACK SEARCH VECTOR FUNCTION (simple config)
-- ============================================================================
CREATE OR REPLACE FUNCTION track_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple', COALESCE(NEW.title, '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- ============================================================================
-- BACKFILL EXISTING ROWS (simple config)
-- ============================================================================
UPDATE "Artist" SET "searchVector" =
  setweight(to_tsvector('simple', COALESCE(name, '')), 'A');

UPDATE "Album" SET "searchVector" =
  setweight(to_tsvector('simple', COALESCE(title, '')), 'A');

UPDATE "Track" SET "searchVector" =
  setweight(to_tsvector('simple', COALESCE(title, '')), 'A');

-- ============================================================================
-- TRIGRAM INDEX ON Artist.normalizedName (folded fuzzy matching)
-- ============================================================================
CREATE INDEX IF NOT EXISTS "Artist_normalizedName_trgm_idx"
  ON "Artist" USING GIN ("normalizedName" gin_trgm_ops);
