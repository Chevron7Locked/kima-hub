-- A title or name edited in Kima is shown in place of the file's, so search must find it. The search vectors held only the
-- file's title/name; they now hold both. The triggers rebuild a vector when either column changes, and every row with an
-- edited name is rebuilt once here (the rest already hold their file's name alone).

CREATE OR REPLACE FUNCTION artist_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.name, '') || ' ' || COALESCE(NEW."displayName", '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artist_search_vector_update ON "Artist";
CREATE TRIGGER artist_search_vector_update
  BEFORE INSERT OR UPDATE OF name, "displayName"
  ON "Artist"
  FOR EACH ROW
  EXECUTE FUNCTION artist_search_vector_trigger();

CREATE OR REPLACE FUNCTION album_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW."displayTitle", '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS album_search_vector_update ON "Album";
CREATE TRIGGER album_search_vector_update
  BEFORE INSERT OR UPDATE OF title, "displayTitle"
  ON "Album"
  FOR EACH ROW
  EXECUTE FUNCTION album_search_vector_trigger();

CREATE OR REPLACE FUNCTION track_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW."displayTitle", '')), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS track_search_vector_update ON "Track";
CREATE TRIGGER track_search_vector_update
  BEFORE INSERT OR UPDATE OF title, "displayTitle"
  ON "Track"
  FOR EACH ROW
  EXECUTE FUNCTION track_search_vector_trigger();

-- Backfill.
UPDATE "Artist" SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE("displayName", '')), 'A')
  WHERE "displayName" IS NOT NULL;

UPDATE "Album" SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE("displayTitle", '')), 'A')
  WHERE "displayTitle" IS NOT NULL;

UPDATE "Track" SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE("displayTitle", '')), 'A')
  WHERE "displayTitle" IS NOT NULL;
