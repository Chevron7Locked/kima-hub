-- When the one-time sort of albums the old scanner filed ran (services/discovery/sortDiscoverAlbums.ts): null on the
-- installs that existed before it, so they are sorted once; a settings row created later is born sorted, since the
-- scanner that filed by guesswork never ran there.
ALTER TABLE "SystemSettings" ADD COLUMN "discoverAlbumsSortedAt" TIMESTAMP(3);
ALTER TABLE "SystemSettings" ALTER COLUMN "discoverAlbumsSortedAt" SET DEFAULT CURRENT_TIMESTAMP;
