-- Fix tracks with existing embeddings that were incorrectly marked as failed/pending/processing
UPDATE "Track"
SET
    "analysisStatus" = 'completed',
    "analysisError" = NULL,
    "analysisStartedAt" = NULL
WHERE id IN (
    SELECT te.track_id
    FROM track_embeddings te
    WHERE te.track_id = "Track".id
)
AND "analysisStatus" IN ('failed', 'pending', 'processing');

-- Clean up stale EnrichmentFailure records for tracks that are now completed
DELETE FROM "EnrichmentFailure"
WHERE "entityType" = 'audio'
  AND EXISTS (
      SELECT 1 FROM "Track" t
      WHERE t.id = "EnrichmentFailure"."entityId"
        AND t."analysisStatus" = 'completed'
  );

-- Verify results
SELECT 
    'Before Fix Status' as info,
    "analysisStatus",
    COUNT(*) as count
FROM "Track"
GROUP BY "analysisStatus";

SELECT 
    'Remaining EnrichmentFailures (audio)' as info,
    COUNT(*) as count
FROM "EnrichmentFailure"
WHERE "entityType" = 'audio';
