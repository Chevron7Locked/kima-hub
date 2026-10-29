-- The "download path" setting was saved but never read: Lidarr and Soulseek both download into the music folder.
ALTER TABLE "SystemSettings" DROP COLUMN "downloadPath";
