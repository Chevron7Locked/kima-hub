-- CreateTable
CREATE TABLE "RemovalLog" (
    "id" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "albumTitle" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'file-missing-grace',
    "artifacts" JSONB,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemovalLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemovalLog_removedAt_idx" ON "RemovalLog"("removedAt");
