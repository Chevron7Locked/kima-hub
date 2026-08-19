-- Records when a track entered scanStatus='validating' so a stale-scan reaper can
-- release rows whose validation job was lost. Track."updatedAt" cannot serve this
-- purpose: unrelated bulk writes (e.g. the vibe sweep) touch it, so it does not
-- measure scan age.
ALTER TABLE "Track" ADD COLUMN "scanStartedAt" TIMESTAMP(3);
