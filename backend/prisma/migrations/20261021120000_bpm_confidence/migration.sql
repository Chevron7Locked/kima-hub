-- The tempo extractor's confidence in its beat detection, kept next to bpm. Tracks analysed before this keep NULL
-- until they are analysed again.
ALTER TABLE "Track" ADD COLUMN IF NOT EXISTS "bpmConfidence" DOUBLE PRECISION;
