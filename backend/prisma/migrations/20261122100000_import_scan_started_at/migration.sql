-- When an import moved to scanning, kept apart from updatedAt so a re-queued scan does not restart the clock on a scan that never finishes.
ALTER TABLE "SpotifyImportJob" ADD COLUMN "scanStartedAt" TIMESTAMP(3);
