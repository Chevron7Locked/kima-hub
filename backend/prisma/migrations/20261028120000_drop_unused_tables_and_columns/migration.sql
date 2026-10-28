-- Tables and columns nothing reads. Dropping a table drops its keys and indexes; dropping a column drops its index.
-- MoodBucket: mood pages draw from their recipes, not this table. subsonic_play_queue: the Subsonic queue lives in
-- PlaybackState. DislikedEntity: no dislike feature exists.
DROP TABLE "MoodBucket";
DROP TABLE "subsonic_play_queue";
DROP TABLE "DislikedEntity";

ALTER TABLE "DiscoveryAlbum"
    DROP COLUMN "folderPath",
    DROP COLUMN "weekEndDate";

ALTER TABLE "DiscoveryTrack"
    DROP COLUMN "inPlaylistCount",
    DROP COLUMN "userKept";

ALTER TABLE "Playlist" DROP COLUMN "spotifyPlaylistUrl";

ALTER TABLE "Podcast"
    DROP COLUMN "refreshInterval",
    DROP COLUMN "autoRefresh";

-- autoEnrichMetadata was a settings switch that changed nothing but which settings rows showed.
ALTER TABLE "SystemSettings"
    DROP COLUMN "autoEnrichMetadata",
    DROP COLUMN "downloadRetryAttempts",
    DROP COLUMN "spotifyClientId",
    DROP COLUMN "spotifyClientSecret";

ALTER TABLE "User" DROP COLUMN "enrichmentSettings";

-- A new Discover config already starts at 10 songs (routes/discover.ts); the column default now agrees.
ALTER TABLE "UserDiscoverConfig" ALTER COLUMN "playlistSize" SET DEFAULT 10;
