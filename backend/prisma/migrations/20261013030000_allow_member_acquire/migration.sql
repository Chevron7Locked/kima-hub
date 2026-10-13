-- Acquisition: operator-only by default; a Settings toggle opens acquire
-- (never delete) to signed-in members.
ALTER TABLE "SystemSettings" ADD COLUMN "allowMemberAcquire" BOOLEAN NOT NULL DEFAULT false;
