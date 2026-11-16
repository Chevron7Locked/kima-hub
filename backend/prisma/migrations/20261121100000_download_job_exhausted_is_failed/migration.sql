-- "exhausted" was listed as a download job status but nothing ever wrote it: a job that runs out of attempts is "failed".
-- A row left with it is a failed job.
UPDATE "DownloadJob" SET status = 'failed' WHERE status = 'exhausted';
