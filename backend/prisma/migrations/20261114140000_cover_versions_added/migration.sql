-- An audiobook's cover version: a digest of the cached cover's bytes, taken when it was stored. Null until the one-time
-- pass (or the next sync) fills it.
ALTER TABLE "Audiobook" ADD COLUMN "coverVersion" TEXT;

-- When the one-time pass that gave every stored cover value a version ran. Existing installs start with it unset, so the
-- pass runs once; a new install's settings row gets the default and skips it (it has no unversioned covers).
ALTER TABLE "SystemSettings" ADD COLUMN "coverVersionsAddedAt" TIMESTAMP(3);
ALTER TABLE "SystemSettings" ALTER COLUMN "coverVersionsAddedAt" SET DEFAULT CURRENT_TIMESTAMP;
