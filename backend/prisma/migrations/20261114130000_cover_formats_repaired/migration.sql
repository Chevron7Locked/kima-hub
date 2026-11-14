-- When the one-time pass that converted stored covers holding another picture format under a .jpg name ran. Existing
-- installs start with it unset, so the pass runs once; a new install's settings row gets the default and skips it (it
-- has no old covers).
ALTER TABLE "SystemSettings" ADD COLUMN "coverFormatsRepairedAt" TIMESTAMP(3);
ALTER TABLE "SystemSettings" ALTER COLUMN "coverFormatsRepairedAt" SET DEFAULT CURRENT_TIMESTAMP;
