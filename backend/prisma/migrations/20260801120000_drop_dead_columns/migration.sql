-- Columns with no reader anywhere in the codebase.
--
-- DownloadJob.triedReleases / releaseIndex were Soulseek release-cycling state:
-- the client walked a candidate list and remembered where it was. Lidarr picks
-- its own release, so nothing has written or read them since the tear-out.
--
-- SystemSettings.maxConcurrentDownloads is a tear-out artefact. The migration
-- that renamed soulseekConcurrentDownloads -> concurrentDownloads left it
-- sitting next to a pre-existing near-identical key; `concurrentDownloads` is
-- the live one (acquisitionService, spotifyImport, discoverWeekly and the UI
-- all read it) and this one was only ever echoed back by the settings CRUD.
--
-- SystemSettings.downloadRetryAttempts is the same shape: settings CRUD only.
--
-- SystemSettings.audioAnalyzerWorkers configured the audio-analyzer service,
-- which the vibe-engine replaced. It was not even in the backend's settings
-- schema, so the server never accepted it -- the frontend carried a field the
-- API rejected and nothing consumed.
ALTER TABLE "DownloadJob"    DROP COLUMN IF EXISTS "triedReleases";
ALTER TABLE "DownloadJob"    DROP COLUMN IF EXISTS "releaseIndex";
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "maxConcurrentDownloads";
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "downloadRetryAttempts";
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "audioAnalyzerWorkers";
