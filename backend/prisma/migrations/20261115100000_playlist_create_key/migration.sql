-- A playlist made with an Idempotency-Key keeps it for 24 hours, so a retried create returns the same playlist.
ALTER TABLE "Playlist" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Playlist_userId_idempotencyKey_key" ON "Playlist"("userId", "idempotencyKey");
