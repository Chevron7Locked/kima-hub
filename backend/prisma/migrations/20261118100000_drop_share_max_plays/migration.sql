-- A share link has no play limit: nothing ever set one, and `playCount` now counts visits to the share.
ALTER TABLE "share_links" DROP COLUMN "maxPlays";
