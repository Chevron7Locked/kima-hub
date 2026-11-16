-- A play always counts for something: it either has its song or carries what is needed to count it without one (its
-- kept title). The foreign key sets `trackId` null when a song is deleted, so a delete that did not first settle the
-- song's plays (keep them, or hand them to a copy, or delete a Discover song's) now fails loudly on this constraint
-- instead of leaving a play that no reader can place.
--
-- A play that already breaks the rule is not deleted or repaired here: the migration stops and names how many, so a
-- person decides what becomes of them.
DO $$
DECLARE
    orphaned bigint;
BEGIN
    SELECT count(*) INTO orphaned FROM "Play" WHERE "trackId" IS NULL AND "keptTitle" IS NULL;
    IF orphaned > 0 THEN
        RAISE EXCEPTION 'cannot add the Play check: % play(s) have neither a song nor a kept title (trackId and keptTitle are both null)', orphaned;
    END IF;
END $$;

ALTER TABLE "Play" ADD CONSTRAINT "Play_has_song_or_kept_title" CHECK ("trackId" IS NOT NULL OR "keptTitle" IS NOT NULL);
