-- Create targetMbid index on DownloadJob (idempotent)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'DownloadJob')
    AND NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'DownloadJob' AND indexname = 'DownloadJob_targetMbid_idx'
    ) THEN
        CREATE INDEX "DownloadJob_targetMbid_idx" ON "DownloadJob"("targetMbid");
    END IF;
END $$;
