-- A pending song's retry is a track job. Like an album, a song has one active job per person and Discover batch,
-- so two retries of one song at once make one job. The oldest active job of a song is kept; the extras end failed.
UPDATE "DownloadJob" d
SET status = 'failed', error = 'Duplicate of another active download', "completedAt" = now()
FROM (
    SELECT id, row_number() OVER (
        PARTITION BY "userId", "targetMbid", "discoveryBatchId"
        ORDER BY "createdAt", id
    ) AS rank
    FROM "DownloadJob"
    WHERE status IN ('pending', 'processing') AND type = 'track' AND "targetMbid" IS NOT NULL
) ranked
WHERE d.id = ranked.id AND ranked.rank > 1;

CREATE UNIQUE INDEX "DownloadJob_active_track_key"
    ON "DownloadJob" ("userId", "targetMbid", "discoveryBatchId") NULLS NOT DISTINCT
    WHERE status IN ('pending', 'processing') AND type = 'track' AND "targetMbid" IS NOT NULL;
