-- When the one-time check of artist and album keys ran (services/identityKeyRepair.ts): null on the installs that
-- existed before it, so they are checked once; a settings row created later is born checked, since its keys were all
-- computed by the scanner.
ALTER TABLE "SystemSettings" ADD COLUMN "identityKeysCheckedAt" TIMESTAMP(3);
ALTER TABLE "SystemSettings" ALTER COLUMN "identityKeysCheckedAt" SET DEFAULT CURRENT_TIMESTAMP;
