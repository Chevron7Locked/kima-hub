-- The podcast cover cache was removed in 1.11 (podcast art loads from the feed's own image); these columns still
-- pointed at the last cached files, which were never refreshed. The files themselves are left where they are.
ALTER TABLE "Podcast" DROP COLUMN "localCoverPath";
ALTER TABLE "PodcastEpisode" DROP COLUMN "localCoverPath";
