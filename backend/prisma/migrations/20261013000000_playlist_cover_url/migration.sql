-- Custom playlist cover art (issue #151): nullable column; NULL means the UI
-- falls back to the generated cover mosaic. Values are `native:playlists/<id>.jpg`
-- references served by the existing /api/library/cover-art route.
ALTER TABLE "Playlist" ADD COLUMN "coverUrl" TEXT;
