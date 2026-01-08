-- Add downloadSource column if it doesn't exist (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'SystemSettings' AND column_name = 'downloadSource'
    ) THEN
        ALTER TABLE "SystemSettings" ADD COLUMN "downloadSource" TEXT NOT NULL DEFAULT 'soulseek';
    END IF;
END $$;

-- Add primaryFailureFallback column if it doesn't exist (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'SystemSettings' AND column_name = 'primaryFailureFallback'
    ) THEN
        ALTER TABLE "SystemSettings" ADD COLUMN "primaryFailureFallback" TEXT NOT NULL DEFAULT 'none';
    END IF;
END $$;
