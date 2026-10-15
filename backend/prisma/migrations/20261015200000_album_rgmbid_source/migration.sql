-- Where an album's MusicBrainz release-group id came from: the files' tags, identification's
-- AcoustID album vote, the manual album enrich's name search, or a person in the album editor.
-- Null on existing rows (treated as tags).
ALTER TABLE "Album" ADD COLUMN "rgMbidSource" TEXT;
