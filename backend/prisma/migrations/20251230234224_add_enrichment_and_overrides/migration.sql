-- CreateTable
CREATE TABLE "EnrichmentFailure" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "skippedAt" TIMESTAMP(3),
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "EnrichmentFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnrichmentFailure_entityType_resolved_idx" ON "EnrichmentFailure"("entityType", "resolved");

-- CreateIndex
CREATE INDEX "EnrichmentFailure_skipped_idx" ON "EnrichmentFailure"("skipped");

-- CreateIndex
CREATE INDEX "EnrichmentFailure_lastFailedAt_idx" ON "EnrichmentFailure"("lastFailedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EnrichmentFailure_entityType_entityId_key" ON "EnrichmentFailure"("entityType", "entityId");
