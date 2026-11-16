-- A play outlives its song: when a library song leaves and no copy takes its history, the delete module writes what is
-- needed to count the play (title, artist, album, recording, length) on the play, and the foreign key lets the song go
-- with the play's `trackId` set null instead of the play going too. A Discover song's plays are deleted with it, by the
-- delete module, so a kept play is always a library play.
ALTER TABLE "Play" DROP CONSTRAINT "Play_trackId_fkey";
ALTER TABLE "Play" ALTER COLUMN "trackId" DROP NOT NULL;
ALTER TABLE "Play" ADD COLUMN "keptTitle" TEXT,
                   ADD COLUMN "keptArtistName" TEXT,
                   ADD COLUMN "keptAlbumTitle" TEXT,
                   ADD COLUMN "keptRecordingMbid" TEXT,
                   ADD COLUMN "keptDuration" INTEGER;
ALTER TABLE "Play" ADD CONSTRAINT "Play_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Play_keptRecordingMbid_idx" ON "Play"("keptRecordingMbid");
