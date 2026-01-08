-- Rename soulseekFallback to primaryFailureFallback (idempotent)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'SystemSettings' AND column_name = 'soulseekFallback'
    ) THEN
        ALTER TABLE "SystemSettings" RENAME COLUMN "soulseekFallback" TO "primaryFailureFallback";
    END IF;
END $$;
