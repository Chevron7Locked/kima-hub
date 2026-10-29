-- Offline album downloads had no client: neither the web app nor the iOS app ever saved songs through them, so
-- nothing wrote these rows. The per-user switch and size limit only fed those routes.
DROP TABLE "CachedTrack";
ALTER TABLE "UserSettings" DROP COLUMN "offlineEnabled";
ALTER TABLE "UserSettings" DROP COLUMN "maxCacheSizeMb";
