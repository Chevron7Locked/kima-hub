-- Nothing reads or writes the per-track scan state: the stage records own every question asked of a song, and the
-- library scan tracks missing files with "missingSince". Dropping the columns drops the indexes built on them;
-- they are named anyway so the migration says what goes.
DROP INDEX IF EXISTS "Track_scanStatus_idx";
DROP INDEX IF EXISTS "Track_scan_pending_idx";

ALTER TABLE "Track" DROP COLUMN "scanStatus",
DROP COLUMN "scanError",
DROP COLUMN "scanStartedAt";
