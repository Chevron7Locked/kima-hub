-- An artist's song count now counts library songs only (Discover songs are not the library's). Marking every artist
-- uncounted makes the server recount them all once at startup (isBackfillNeeded, artistCountsService.ts).
UPDATE "Artist" SET "countsLastUpdated" = NULL;
