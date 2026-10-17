-- The sound model is now LAION-CLAP's music checkpoint through ONNX (label laion-clap-music-onnx-v1). Every vector
-- under another label is from another model or recipe, in an unrelated space: 1.11's general model, or 1.10's music
-- vectors, which came from one random slice of each song. They are removed (their feel and map rows go with them by
-- cascade) and their tracks asked again; a track whose file is gone waits, closed as missing, for a scan to find it.
UPDATE "TrackStage"
   SET status = 'pending', attempt = 0, redelivered = 0, "lastErrorCode" = NULL, "lastErrorMessage" = NULL,
       "failureClass" = NULL, retryable = true, "nextRetryAt" = NULL, evidence = NULL, "startedAt" = NULL,
       "finishedAt" = NULL, "decidedAt" = NULL, "decidedBy" = NULL
 WHERE stage = 'embedding'
   AND "trackId" IN (SELECT track_id FROM track_embeddings WHERE model_version <> 'laion-clap-music-onnx-v1')
   AND "trackId" IN (SELECT id FROM "Track" WHERE "missingSince" IS NULL);

UPDATE "TrackStage"
   SET status = 'failed', retryable = false, "nextRetryAt" = NULL,
       "failureClass" = 'FILE_MISSING', "lastErrorCode" = 'FILE_MISSING',
       "lastErrorMessage" = 'file missing from the library; a scan that finds it again re-opens this record',
       evidence = jsonb_build_object('reason', 'file missing', 'closure', 'file-missing'),
       "startedAt" = COALESCE("startedAt", now()), "finishedAt" = COALESCE("finishedAt", now())
 WHERE stage = 'embedding'
   AND "trackId" IN (SELECT track_id FROM track_embeddings WHERE model_version <> 'laion-clap-music-onnx-v1')
   AND "trackId" IN (SELECT id FROM "Track" WHERE "missingSince" IS NOT NULL);

UPDATE "Track"
   SET "vibeAnalysisStatus" = 'pending', "vibeAnalysisStartedAt" = NULL, "vibeAnalysisError" = NULL,
       "vibeAnalysisRetryCount" = 0, "vibeAnalysisStatusUpdatedAt" = NULL
 WHERE id IN (SELECT track_id FROM track_embeddings WHERE model_version <> 'laion-clap-music-onnx-v1');

DELETE FROM track_embeddings WHERE model_version <> 'laion-clap-music-onnx-v1';
