-- Add MusicBrainz artist aliases to the artist full-text search vector.
--
-- Artists frequently have alternate names: punctuation/spacing variants
-- ("JAY-Z" vs "Jay Z"), localized names, and stage names. We already fetch
-- MusicBrainz aliases during artist enrichment; this stores them on the row
-- and folds them into "searchVector" so the EXISTING full-text search arm
-- (backend/src/services/search.ts, to_tsquery('simple', ...)) matches an
-- artist by an alias with no query change.
--
-- 'simple' matches the query side (same config the query uses, no stemming /
-- stopwords). Aliases get weight 'B' so they rank below the primary name
-- (weight 'A'): an exact name hit always outranks an alias-only hit.

-- ============================================================================
-- COLUMN
-- ============================================================================
ALTER TABLE "Artist" ADD COLUMN IF NOT EXISTS "aliases" TEXT[] NOT NULL DEFAULT '{}';

-- ============================================================================
-- ARTIST SEARCH VECTOR FUNCTION (name + aliases, simple config)
-- ============================================================================
CREATE OR REPLACE FUNCTION artist_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(array_to_string(NEW.aliases, ' '), '')), 'B');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Recreate the trigger so it also fires when "aliases" changes (the previous
-- definition only fired on "name").
DROP TRIGGER IF EXISTS artist_search_vector_update ON "Artist";
CREATE TRIGGER artist_search_vector_update
  BEFORE INSERT OR UPDATE OF name, aliases ON "Artist"
  FOR EACH ROW EXECUTE FUNCTION artist_search_vector_trigger();

-- ============================================================================
-- BACKFILL EXISTING ROWS (aliases default to '{}', so this is effectively the
-- same vector as before until enrichment populates aliases)
-- ============================================================================
UPDATE "Artist" SET "searchVector" =
  setweight(to_tsvector('simple', COALESCE(name, '')), 'A') ||
  setweight(to_tsvector('simple', COALESCE(array_to_string(aliases, ' '), '')), 'B');
