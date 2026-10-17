-- AI-assisted playlist generation (opt-in): provider configuration and global
-- guardrails. aiApiKey is stored encrypted at rest (see utils/encryptedFields.ts);
-- the aiBlocked* columns hold JSON arrays as strings (stringified at the route
-- edge, parsed back on read).

ALTER TABLE "SystemSettings" ADD COLUMN "aiPlaylistEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemSettings" ADD COLUMN "aiProvider" TEXT NOT NULL DEFAULT 'openai';
ALTER TABLE "SystemSettings" ADD COLUMN "aiApiBaseUrl" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "aiApiKey" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "aiMaxPlaylistSize" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "SystemSettings" ADD COLUMN "aiBlockedGenres" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "aiBlockedArtists" TEXT;
