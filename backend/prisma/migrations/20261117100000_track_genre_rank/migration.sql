-- A song's genre tags keep their place in the recording's answer (the most voted is rank 0), so a song shows its most
-- voted genre first. Rows stored before this have no rank and come after the ranked ones, in name order.
ALTER TABLE "TrackGenre" ADD COLUMN "rank" INTEGER;
