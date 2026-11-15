-- A keyed create also keeps a hash of what it asked for, so the same key with other parameters is refused (422) instead of answered with the first playlist.
ALTER TABLE "Playlist" ADD COLUMN "idempotencyParams" TEXT;
