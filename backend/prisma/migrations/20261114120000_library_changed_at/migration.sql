-- When the library a Subsonic client lists last changed, served as getArtists' lastModified. An existing install starts at
-- the upgrade, so clients refresh once and then only when a scan or a name edit changes what they list.
ALTER TABLE "SystemSettings" ADD COLUMN "libraryChangedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
