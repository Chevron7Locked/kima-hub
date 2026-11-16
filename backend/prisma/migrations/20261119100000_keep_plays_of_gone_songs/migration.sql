-- A play outlives its song: when a song leaves the library and no copy takes its history, the delete module writes what
-- is needed to count the play (title, artist, album, recording, length, library or Discover) on the play, and the
-- foreign key lets the song go with the play's `trackId` set null instead of the play going too.
ALTER TABLE "Play" DROP CONSTRAINT "Play_trackId_fkey";
ALTER TABLE "Play" ALTER COLUMN "trackId" DROP NOT NULL;
ALTER TABLE "Play" ADD COLUMN "keptTitle" TEXT,
                   ADD COLUMN "keptArtistName" TEXT,
                   ADD COLUMN "keptAlbumTitle" TEXT,
                   ADD COLUMN "keptRecordingMbid" TEXT,
                   ADD COLUMN "keptDuration" INTEGER,
                   ADD COLUMN "keptLibrary" BOOLEAN;
ALTER TABLE "Play" ADD CONSTRAINT "Play_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Play_keptRecordingMbid_idx" ON "Play"("keptRecordingMbid");
