-- Add slskd integration settings (issue #164).
-- soulseekMode selects the Soulseek backend: "p2p" (built-in client, needs
-- Soulseek credentials) or "slskd" (route via a slskd REST API instance, which
-- holds its own Soulseek account — so Kima needs no username/password).
ALTER TABLE "SystemSettings" ADD COLUMN "soulseekMode" TEXT DEFAULT 'p2p';
ALTER TABLE "SystemSettings" ADD COLUMN "slskdUrl" TEXT;
ALTER TABLE "SystemSettings" ADD COLUMN "slskdApiKey" TEXT;
