-- When an album first arrived, for "recently added". Only the insert writes it, so a rescan cannot move an album up.
-- Albums already there take their sync time, the earliest add time the schema kept.
ALTER TABLE "Album" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "Album" SET "createdAt" = "lastSynced";
