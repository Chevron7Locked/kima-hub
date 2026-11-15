-- A playlist can hold the same song more than once: the order is the rank, and each copy is its own item.
-- The lookup of a playlist's items by song keeps an index, now not unique.
DROP INDEX "PlaylistItem_playlistId_trackId_key";

CREATE INDEX "PlaylistItem_playlistId_trackId_idx" ON "PlaylistItem"("playlistId", "trackId");
