-- CreateIndex
CREATE INDEX IF NOT EXISTS "Artist_enrichmentStatus_idx" ON "Artist"("enrichmentStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Track_analysisStatus_idx" ON "Track"("analysisStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Track_vibeAnalysisStatus_idx" ON "Track"("vibeAnalysisStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Track_analysisStatus_vibeAnalysisStatus_idx" ON "Track"("analysisStatus", "vibeAnalysisStatus");
