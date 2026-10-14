-- The reconcile decision is confirmation by consecutive scans, not a grace period;
-- align the audit row's default label with what the sweep actually records.
ALTER TABLE "RemovalLog" ALTER COLUMN "reason" SET DEFAULT 'file-missing-confirmed';
