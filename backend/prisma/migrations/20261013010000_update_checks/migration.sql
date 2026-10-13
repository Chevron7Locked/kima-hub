-- Update checks: a daily anonymous look at GitHub releases so the UI can flag
-- a newer server. Off suits air-gapped installs; nothing else changes.
ALTER TABLE "SystemSettings" ADD COLUMN "updateChecksEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SystemSettings" ADD COLUMN "lastUpdateCheck" TIMESTAMP(3);
ALTER TABLE "SystemSettings" ADD COLUMN "latestKnownVersion" TEXT;
