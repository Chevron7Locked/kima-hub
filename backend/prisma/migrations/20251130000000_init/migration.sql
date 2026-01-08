-- CreateEnum
CREATE TYPE "DiscoverStatus" AS ENUM ('ACTIVE', 'LIKED', 'MOVED', 'DELETED');

-- CreateEnum
CREATE TYPE "ListenSource" AS ENUM ('LIBRARY', 'DISCOVERY', 'DISCOVERY_KEPT');

-- CreateEnum
CREATE TYPE "AlbumLocation" AS ENUM ('LIBRARY', 'DISCOVER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "enrichmentSettings" JSONB,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "twoFactorRecoveryCodes" TEXT,
    "moodMixParams" JSONB,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "userId" TEXT NOT NULL,
    "playbackQuality" TEXT NOT NULL DEFAULT 'original',
    "wifiOnly" BOOLEAN NOT NULL DEFAULT false,
    "offlineEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxCacheSizeMb" INTEGER NOT NULL DEFAULT 10240,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PlaybackState" (
    "userId" TEXT NOT NULL,
    "playbackType" TEXT NOT NULL,
    "trackId" TEXT,
    "audiobookId" TEXT,
    "podcastId" TEXT,
    "queue" JSONB,
    "currentIndex" INTEGER NOT NULL DEFAULT 0,
    "isShuffle" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaybackState_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lidarrEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lidarrUrl" TEXT DEFAULT 'http://localhost:8686',
    "lidarrApiKey" TEXT,
    "openaiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "openaiApiKey" TEXT,
    "openaiModel" TEXT DEFAULT 'gpt-4',
    "openaiBaseUrl" TEXT,
    "fanartEnabled" BOOLEAN NOT NULL DEFAULT false,
    "fanartApiKey" TEXT,
    "audiobookshelfEnabled" BOOLEAN NOT NULL DEFAULT false,
    "audiobookshelfUrl" TEXT DEFAULT 'http://localhost:13378',
    "audiobookshelfApiKey" TEXT,
    "soulseekUsername" TEXT,
    "soulseekPassword" TEXT,
    "spotifyClientId" TEXT,
    "spotifyClientSecret" TEXT,
    "musicPath" TEXT DEFAULT '/music',
    "downloadPath" TEXT DEFAULT '/downloads',
    "autoSync" BOOLEAN NOT NULL DEFAULT true,
    "autoEnrichMetadata" BOOLEAN NOT NULL DEFAULT true,
    "maxConcurrentDownloads" INTEGER NOT NULL DEFAULT 3,
    "downloadRetryAttempts" INTEGER NOT NULL DEFAULT 3,
    "transcodeCacheMaxGb" INTEGER NOT NULL DEFAULT 10,
    "downloadSource" TEXT NOT NULL DEFAULT 'soulseek',
    "primaryFailureFallback" TEXT NOT NULL DEFAULT 'none',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artist" (
    "id" TEXT NOT NULL,
    "mbid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL DEFAULT '',
    "summary" TEXT,
    "heroUrl" TEXT,
    "genres" JSONB,
    "lastSynced" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEnriched" TIMESTAMP(3),
    "enrichmentStatus" TEXT NOT NULL DEFAULT 'pending',
    "searchVector" tsvector,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Album" (
    "id" TEXT NOT NULL,
    "rgMbid" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "year" INTEGER,
    "coverUrl" TEXT,
    "primaryType" TEXT NOT NULL,
    "label" TEXT,
    "genres" JSONB,
    "lastSynced" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "location" "AlbumLocation" NOT NULL DEFAULT 'LIBRARY',
    "searchVector" tsvector,

    CONSTRAINT "Album_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "trackNo" INTEGER NOT NULL,
    "duration" INTEGER NOT NULL,
    "mime" TEXT,
    "searchVector" tsvector,
    "filePath" TEXT NOT NULL,
    "fileModified" TIMESTAMP(3) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "bpm" DOUBLE PRECISION,
    "beatsCount" INTEGER,
    "key" TEXT,
    "keyScale" TEXT,
    "keyStrength" DOUBLE PRECISION,
    "energy" DOUBLE PRECISION,
    "loudness" DOUBLE PRECISION,
    "dynamicRange" DOUBLE PRECISION,
    "danceability" DOUBLE PRECISION,
    "valence" DOUBLE PRECISION,
    "arousal" DOUBLE PRECISION,
    "instrumentalness" DOUBLE PRECISION,
    "acousticness" DOUBLE PRECISION,
    "speechiness" DOUBLE PRECISION,
    "moodHappy" DOUBLE PRECISION,
    "moodSad" DOUBLE PRECISION,
    "moodRelaxed" DOUBLE PRECISION,
    "moodAggressive" DOUBLE PRECISION,
    "moodParty" DOUBLE PRECISION,
    "moodAcoustic" DOUBLE PRECISION,
    "moodElectronic" DOUBLE PRECISION,
    "danceabilityMl" DOUBLE PRECISION,
    "moodTags" TEXT[],
    "essentiaGenres" TEXT[],
    "lastfmTags" TEXT[],
    "analysisStatus" TEXT NOT NULL DEFAULT 'pending',
    "analysisVersion" TEXT,
    "analysisMode" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "analysisError" TEXT,
    "analysisRetryCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscodedFile" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "cachePath" TEXT NOT NULL,
    "cacheSize" INTEGER NOT NULL,
    "sourceModified" TIMESTAMP(3) NOT NULL,
    "lastAccessed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscodedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Play" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "playedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "ListenSource" NOT NULL DEFAULT 'LIBRARY',

    CONSTRAINT "Play_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Playlist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mixId" TEXT,
    "name" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spotifyPlaylistId" TEXT,
    "spotifyPlaylistUrl" TEXT,

    CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HiddenPlaylist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiddenPlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistItem" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,

    CONSTRAINT "PlaylistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistPendingTrack" (
    "id" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "spotifyArtist" TEXT NOT NULL,
    "spotifyTitle" TEXT NOT NULL,
    "spotifyAlbum" TEXT NOT NULL,
    "albumMbid" TEXT,
    "artistMbid" TEXT,
    "deezerPreviewUrl" TEXT,
    "sort" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaylistPendingTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpotifyImportJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyPlaylistId" TEXT NOT NULL,
    "playlistName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "albumsTotal" INTEGER NOT NULL,
    "albumsCompleted" INTEGER NOT NULL DEFAULT 0,
    "tracksTotal" INTEGER NOT NULL,
    "tracksMatched" INTEGER NOT NULL DEFAULT 0,
    "tracksDownloadable" INTEGER NOT NULL DEFAULT 0,
    "createdPlaylistId" TEXT,
    "error" TEXT,
    "pendingTracks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotifyImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Genre" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Genre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackGenre" (
    "trackId" TEXT NOT NULL,
    "genreId" TEXT NOT NULL,

    CONSTRAINT "TrackGenre_pkey" PRIMARY KEY ("trackId","genreId")
);

-- CreateTable
CREATE TABLE "SimilarArtist" (
    "fromArtistId" TEXT NOT NULL,
    "toArtistId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "SimilarArtist_pkey" PRIMARY KEY ("fromArtistId","toArtistId")
);

-- CreateTable
CREATE TABLE "OwnedAlbum" (
    "artistId" TEXT NOT NULL,
    "rgMbid" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "OwnedAlbum_pkey" PRIMARY KEY ("artistId","rgMbid")
);

-- CreateTable
CREATE TABLE "DownloadJob" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetMbid" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "lidarrRef" TEXT,
    "lidarrAlbumId" INTEGER,
    "metadata" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "discoveryBatchId" TEXT,
    "triedReleases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "releaseIndex" INTEGER NOT NULL DEFAULT 0,
    "artistMbid" TEXT,
    "cleared" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DownloadJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListeningState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "trackId" TEXT,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListeningState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryAlbum" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rgMbid" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "artistMbid" TEXT,
    "albumTitle" TEXT NOT NULL,
    "lidarrAlbumId" INTEGER,
    "downloadedAt" TIMESTAMP(3),
    "folderPath" TEXT NOT NULL DEFAULT '',
    "weekStartDate" TIMESTAMP(3) NOT NULL,
    "weekEndDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DiscoverStatus" NOT NULL DEFAULT 'ACTIVE',
    "likedAt" TIMESTAMP(3),
    "similarity" DOUBLE PRECISION,
    "tier" TEXT,

    CONSTRAINT "DiscoveryAlbum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryTrack" (
    "id" TEXT NOT NULL,
    "discoveryAlbumId" TEXT NOT NULL,
    "trackId" TEXT,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "inPlaylistCount" INTEGER NOT NULL DEFAULT 0,
    "userKept" BOOLEAN NOT NULL DEFAULT false,
    "lastPlayedAt" TIMESTAMP(3),

    CONSTRAINT "DiscoveryTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LikedTrack" (
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "likedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LikedTrack_pkey" PRIMARY KEY ("userId","trackId")
);

-- CreateTable
CREATE TABLE "DislikedEntity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "dislikedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DislikedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CachedTrack" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "fileSizeMb" DOUBLE PRECISION NOT NULL,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CachedTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudiobookProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "audiobookshelfId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "coverUrl" TEXT,
    "currentTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isFinished" BOOLEAN NOT NULL DEFAULT false,
    "lastPlayedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudiobookProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audiobook" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "narrator" TEXT,
    "description" TEXT,
    "publishedYear" INTEGER,
    "publisher" TEXT,
    "series" TEXT,
    "seriesSequence" TEXT,
    "duration" DOUBLE PRECISION,
    "numTracks" INTEGER,
    "numChapters" INTEGER,
    "size" BIGINT,
    "isbn" TEXT,
    "asin" TEXT,
    "language" TEXT,
    "genres" TEXT[],
    "tags" TEXT[],
    "localCoverPath" TEXT,
    "coverUrl" TEXT,
    "audioUrl" TEXT NOT NULL,
    "libraryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Audiobook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "podcast_recommendations" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "recommendedId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "description" TEXT,
    "coverUrl" TEXT,
    "episodeCount" INTEGER NOT NULL DEFAULT 0,
    "feedUrl" TEXT,
    "itunesId" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "podcast_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Podcast" (
    "id" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "localCoverPath" TEXT,
    "itunesId" TEXT,
    "language" TEXT,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "episodeCount" INTEGER NOT NULL DEFAULT 0,
    "lastRefreshed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "refreshInterval" INTEGER NOT NULL DEFAULT 3600,
    "autoRefresh" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Podcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastEpisode" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "audioUrl" TEXT NOT NULL,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "episodeNumber" INTEGER,
    "season" INTEGER,
    "imageUrl" TEXT,
    "localCoverPath" TEXT,
    "fileSize" INTEGER,
    "mimeType" TEXT DEFAULT 'audio/mpeg',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastSubscription" (
    "userId" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastSubscription_pkey" PRIMARY KEY ("userId","podcastId")
);

-- CreateTable
CREATE TABLE "PodcastProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "currentTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isFinished" BOOLEAN NOT NULL DEFAULT false,
    "lastPlayedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PodcastDownload" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "fileSizeMb" DOUBLE PRECISION NOT NULL,
    "downloadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastDownload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoverExclusion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "albumMbid" TEXT NOT NULL,
    "artistName" TEXT,
    "albumTitle" TEXT,
    "lastSuggestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoverExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDiscoverConfig" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playlistSize" INTEGER NOT NULL DEFAULT 40,
    "maxRetryAttempts" INTEGER NOT NULL DEFAULT 3,
    "exclusionMonths" INTEGER NOT NULL DEFAULT 6,
    "downloadRatio" DOUBLE PRECISION NOT NULL DEFAULT 1.3,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastGeneratedAt" TIMESTAMP(3),

    CONSTRAINT "UserDiscoverConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnavailableAlbum" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "albumTitle" TEXT NOT NULL,
    "albumMbid" TEXT NOT NULL,
    "artistMbid" TEXT,
    "similarity" DOUBLE PRECISION NOT NULL,
    "tier" TEXT NOT NULL,
    "weekStartDate" TIMESTAMP(3) NOT NULL,
    "previewUrl" TEXT,
    "deezerTrackId" TEXT,
    "deezerAlbumId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "originalAlbumId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnavailableAlbum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "targetSongCount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'downloading',
    "totalAlbums" INTEGER NOT NULL DEFAULT 0,
    "completedAlbums" INTEGER NOT NULL DEFAULT 0,
    "failedAlbums" INTEGER NOT NULL DEFAULT 0,
    "finalSongCount" INTEGER NOT NULL DEFAULT 0,
    "logs" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DiscoveryBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceLinkCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "deviceName" TEXT,
    "apiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "metadata" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "cleared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "PlaybackState_userId_idx" ON "PlaybackState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Artist_mbid_key" ON "Artist"("mbid");

-- CreateIndex
CREATE INDEX "Artist_name_idx" ON "Artist"("name");

-- CreateIndex
CREATE INDEX "Artist_normalizedName_idx" ON "Artist"("normalizedName");

-- CreateIndex
CREATE INDEX "Artist_searchVector_idx" ON "Artist" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "Album_rgMbid_key" ON "Album"("rgMbid");

-- CreateIndex
CREATE INDEX "Album_artistId_idx" ON "Album"("artistId");

-- CreateIndex
CREATE INDEX "Album_location_idx" ON "Album"("location");

-- CreateIndex
CREATE INDEX "Album_title_idx" ON "Album"("title");

-- CreateIndex
CREATE INDEX "Album_searchVector_idx" ON "Album" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "Track_filePath_key" ON "Track"("filePath");

-- CreateIndex
CREATE INDEX "Track_albumId_idx" ON "Track"("albumId");

-- CreateIndex
CREATE INDEX "Track_fileModified_idx" ON "Track"("fileModified");

-- CreateIndex
CREATE INDEX "Track_title_idx" ON "Track"("title");

-- CreateIndex
CREATE INDEX "Track_searchVector_idx" ON "Track" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "Track_analysisStatus_idx" ON "Track"("analysisStatus");

-- CreateIndex
CREATE INDEX "Track_bpm_idx" ON "Track"("bpm");

-- CreateIndex
CREATE INDEX "Track_energy_idx" ON "Track"("energy");

-- CreateIndex
CREATE INDEX "Track_valence_idx" ON "Track"("valence");

-- CreateIndex
CREATE INDEX "Track_danceability_idx" ON "Track"("danceability");

-- CreateIndex
CREATE UNIQUE INDEX "TranscodedFile_cachePath_key" ON "TranscodedFile"("cachePath");

-- CreateIndex
CREATE INDEX "TranscodedFile_trackId_quality_idx" ON "TranscodedFile"("trackId", "quality");

-- CreateIndex
CREATE INDEX "TranscodedFile_lastAccessed_idx" ON "TranscodedFile"("lastAccessed");

-- CreateIndex
CREATE UNIQUE INDEX "TranscodedFile_trackId_quality_key" ON "TranscodedFile"("trackId", "quality");

-- CreateIndex
CREATE INDEX "Play_userId_playedAt_idx" ON "Play"("userId", "playedAt");

-- CreateIndex
CREATE INDEX "Play_trackId_idx" ON "Play"("trackId");

-- CreateIndex
CREATE INDEX "Play_source_idx" ON "Play"("source");

-- CreateIndex
CREATE INDEX "Playlist_userId_idx" ON "Playlist"("userId");

-- CreateIndex
CREATE INDEX "Playlist_spotifyPlaylistId_idx" ON "Playlist"("spotifyPlaylistId");

-- CreateIndex
CREATE UNIQUE INDEX "Playlist_userId_mixId_key" ON "Playlist"("userId", "mixId");

-- CreateIndex
CREATE INDEX "HiddenPlaylist_userId_idx" ON "HiddenPlaylist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "HiddenPlaylist_userId_playlistId_key" ON "HiddenPlaylist"("userId", "playlistId");

-- CreateIndex
CREATE INDEX "PlaylistItem_playlistId_sort_idx" ON "PlaylistItem"("playlistId", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistItem_playlistId_trackId_key" ON "PlaylistItem"("playlistId", "trackId");

-- CreateIndex
CREATE INDEX "PlaylistPendingTrack_playlistId_idx" ON "PlaylistPendingTrack"("playlistId");

-- CreateIndex
CREATE INDEX "PlaylistPendingTrack_albumMbid_idx" ON "PlaylistPendingTrack"("albumMbid");

-- CreateIndex
CREATE INDEX "PlaylistPendingTrack_artistMbid_idx" ON "PlaylistPendingTrack"("artistMbid");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistPendingTrack_playlistId_spotifyArtist_spotifyTitle_key" ON "PlaylistPendingTrack"("playlistId", "spotifyArtist", "spotifyTitle");

-- CreateIndex
CREATE INDEX "SpotifyImportJob_userId_idx" ON "SpotifyImportJob"("userId");

-- CreateIndex
CREATE INDEX "SpotifyImportJob_status_idx" ON "SpotifyImportJob"("status");

-- CreateIndex
CREATE INDEX "SpotifyImportJob_createdAt_idx" ON "SpotifyImportJob"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Genre_name_key" ON "Genre"("name");

-- CreateIndex
CREATE INDEX "TrackGenre_genreId_idx" ON "TrackGenre"("genreId");

-- CreateIndex
CREATE INDEX "SimilarArtist_fromArtistId_idx" ON "SimilarArtist"("fromArtistId");

-- CreateIndex
CREATE INDEX "OwnedAlbum_artistId_idx" ON "OwnedAlbum"("artistId");

-- CreateIndex
CREATE UNIQUE INDEX "DownloadJob_correlationId_key" ON "DownloadJob"("correlationId");

-- CreateIndex
CREATE INDEX "DownloadJob_userId_status_idx" ON "DownloadJob"("userId", "status");

-- CreateIndex
CREATE INDEX "DownloadJob_status_idx" ON "DownloadJob"("status");

-- CreateIndex
CREATE INDEX "DownloadJob_discoveryBatchId_idx" ON "DownloadJob"("discoveryBatchId");

-- CreateIndex
CREATE INDEX "DownloadJob_correlationId_idx" ON "DownloadJob"("correlationId");

-- CreateIndex
CREATE INDEX "DownloadJob_startedAt_idx" ON "DownloadJob"("startedAt");

-- CreateIndex
CREATE INDEX "DownloadJob_lidarrRef_idx" ON "DownloadJob"("lidarrRef");

-- CreateIndex
CREATE INDEX "DownloadJob_artistMbid_idx" ON "DownloadJob"("artistMbid");

-- CreateIndex
CREATE INDEX "DownloadJob_targetMbid_idx" ON "DownloadJob"("targetMbid");

-- CreateIndex
CREATE INDEX "ListeningState_userId_idx" ON "ListeningState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ListeningState_userId_kind_entityId_key" ON "ListeningState"("userId", "kind", "entityId");

-- CreateIndex
CREATE INDEX "DiscoveryAlbum_userId_weekStartDate_idx" ON "DiscoveryAlbum"("userId", "weekStartDate");

-- CreateIndex
CREATE INDEX "DiscoveryAlbum_downloadedAt_idx" ON "DiscoveryAlbum"("downloadedAt");

-- CreateIndex
CREATE INDEX "DiscoveryAlbum_status_idx" ON "DiscoveryAlbum"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryAlbum_userId_weekStartDate_rgMbid_key" ON "DiscoveryAlbum"("userId", "weekStartDate", "rgMbid");

-- CreateIndex
CREATE INDEX "DiscoveryTrack_discoveryAlbumId_idx" ON "DiscoveryTrack"("discoveryAlbumId");

-- CreateIndex
CREATE INDEX "DiscoveryTrack_userKept_idx" ON "DiscoveryTrack"("userKept");

-- CreateIndex
CREATE INDEX "DiscoveryTrack_lastPlayedAt_idx" ON "DiscoveryTrack"("lastPlayedAt");

-- CreateIndex
CREATE INDEX "LikedTrack_userId_idx" ON "LikedTrack"("userId");

-- CreateIndex
CREATE INDEX "LikedTrack_likedAt_idx" ON "LikedTrack"("likedAt");

-- CreateIndex
CREATE INDEX "DislikedEntity_userId_entityType_idx" ON "DislikedEntity"("userId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "DislikedEntity_userId_entityType_entityId_key" ON "DislikedEntity"("userId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "CachedTrack_userId_idx" ON "CachedTrack"("userId");

-- CreateIndex
CREATE INDEX "CachedTrack_lastAccessedAt_idx" ON "CachedTrack"("lastAccessedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CachedTrack_userId_trackId_quality_key" ON "CachedTrack"("userId", "trackId", "quality");

-- CreateIndex
CREATE INDEX "AudiobookProgress_userId_lastPlayedAt_idx" ON "AudiobookProgress"("userId", "lastPlayedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AudiobookProgress_userId_audiobookshelfId_key" ON "AudiobookProgress"("userId", "audiobookshelfId");

-- CreateIndex
CREATE INDEX "Audiobook_title_idx" ON "Audiobook"("title");

-- CreateIndex
CREATE INDEX "Audiobook_author_idx" ON "Audiobook"("author");

-- CreateIndex
CREATE INDEX "Audiobook_series_idx" ON "Audiobook"("series");

-- CreateIndex
CREATE INDEX "Audiobook_lastSyncedAt_idx" ON "Audiobook"("lastSyncedAt");

-- CreateIndex
CREATE INDEX "podcast_recommendations_podcastId_expiresAt_idx" ON "podcast_recommendations"("podcastId", "expiresAt");

-- CreateIndex
CREATE INDEX "podcast_recommendations_expiresAt_idx" ON "podcast_recommendations"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Podcast_feedUrl_key" ON "Podcast"("feedUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Podcast_itunesId_key" ON "Podcast"("itunesId");

-- CreateIndex
CREATE INDEX "Podcast_itunesId_idx" ON "Podcast"("itunesId");

-- CreateIndex
CREATE INDEX "Podcast_lastRefreshed_idx" ON "Podcast"("lastRefreshed");

-- CreateIndex
CREATE INDEX "PodcastEpisode_podcastId_publishedAt_idx" ON "PodcastEpisode"("podcastId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastEpisode_podcastId_guid_key" ON "PodcastEpisode"("podcastId", "guid");

-- CreateIndex
CREATE INDEX "PodcastSubscription_userId_idx" ON "PodcastSubscription"("userId");

-- CreateIndex
CREATE INDEX "PodcastSubscription_podcastId_idx" ON "PodcastSubscription"("podcastId");

-- CreateIndex
CREATE INDEX "PodcastProgress_userId_lastPlayedAt_idx" ON "PodcastProgress"("userId", "lastPlayedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastProgress_userId_episodeId_key" ON "PodcastProgress"("userId", "episodeId");

-- CreateIndex
CREATE INDEX "PodcastDownload_userId_idx" ON "PodcastDownload"("userId");

-- CreateIndex
CREATE INDEX "PodcastDownload_lastAccessedAt_idx" ON "PodcastDownload"("lastAccessedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PodcastDownload_userId_episodeId_key" ON "PodcastDownload"("userId", "episodeId");

-- CreateIndex
CREATE INDEX "DiscoverExclusion_userId_expiresAt_idx" ON "DiscoverExclusion"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoverExclusion_userId_albumMbid_key" ON "DiscoverExclusion"("userId", "albumMbid");

-- CreateIndex
CREATE UNIQUE INDEX "UserDiscoverConfig_userId_key" ON "UserDiscoverConfig"("userId");

-- CreateIndex
CREATE INDEX "UnavailableAlbum_userId_weekStartDate_idx" ON "UnavailableAlbum"("userId", "weekStartDate");

-- CreateIndex
CREATE INDEX "UnavailableAlbum_userId_weekStartDate_attemptNumber_idx" ON "UnavailableAlbum"("userId", "weekStartDate", "attemptNumber");

-- CreateIndex
CREATE INDEX "UnavailableAlbum_originalAlbumId_idx" ON "UnavailableAlbum"("originalAlbumId");

-- CreateIndex
CREATE UNIQUE INDEX "UnavailableAlbum_userId_weekStartDate_albumMbid_key" ON "UnavailableAlbum"("userId", "weekStartDate", "albumMbid");

-- CreateIndex
CREATE INDEX "DiscoveryBatch_userId_weekStart_idx" ON "DiscoveryBatch"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "DiscoveryBatch_status_idx" ON "DiscoveryBatch"("status");

-- CreateIndex
CREATE INDEX "DiscoveryBatch_createdAt_idx" ON "DiscoveryBatch"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE INDEX "ApiKey_key_idx" ON "ApiKey"("key");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "ApiKey_lastUsed_idx" ON "ApiKey"("lastUsed");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceLinkCode_code_key" ON "DeviceLinkCode"("code");

-- CreateIndex
CREATE INDEX "DeviceLinkCode_code_expiresAt_idx" ON "DeviceLinkCode"("code", "expiresAt");

-- CreateIndex
CREATE INDEX "DeviceLinkCode_userId_idx" ON "DeviceLinkCode"("userId");

-- CreateIndex
CREATE INDEX "Notification_userId_cleared_idx" ON "Notification"("userId", "cleared");

-- CreateIndex
CREATE INDEX "Notification_userId_read_idx" ON "Notification"("userId", "read");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybackState" ADD CONSTRAINT "PlaybackState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Album" ADD CONSTRAINT "Album_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Track" ADD CONSTRAINT "Track_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscodedFile" ADD CONSTRAINT "TranscodedFile_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Play" ADD CONSTRAINT "Play_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Play" ADD CONSTRAINT "Play_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiddenPlaylist" ADD CONSTRAINT "HiddenPlaylist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HiddenPlaylist" ADD CONSTRAINT "HiddenPlaylist_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistPendingTrack" ADD CONSTRAINT "PlaylistPendingTrack_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotifyImportJob" ADD CONSTRAINT "SpotifyImportJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackGenre" ADD CONSTRAINT "TrackGenre_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackGenre" ADD CONSTRAINT "TrackGenre_genreId_fkey" FOREIGN KEY ("genreId") REFERENCES "Genre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimilarArtist" ADD CONSTRAINT "SimilarArtist_fromArtistId_fkey" FOREIGN KEY ("fromArtistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimilarArtist" ADD CONSTRAINT "SimilarArtist_toArtistId_fkey" FOREIGN KEY ("toArtistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnedAlbum" ADD CONSTRAINT "OwnedAlbum_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadJob" ADD CONSTRAINT "DownloadJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DownloadJob" ADD CONSTRAINT "DownloadJob_discoveryBatchId_fkey" FOREIGN KEY ("discoveryBatchId") REFERENCES "DiscoveryBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListeningState" ADD CONSTRAINT "ListeningState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryAlbum" ADD CONSTRAINT "DiscoveryAlbum_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryTrack" ADD CONSTRAINT "DiscoveryTrack_discoveryAlbumId_fkey" FOREIGN KEY ("discoveryAlbumId") REFERENCES "DiscoveryAlbum"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LikedTrack" ADD CONSTRAINT "LikedTrack_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LikedTrack" ADD CONSTRAINT "LikedTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DislikedEntity" ADD CONSTRAINT "DislikedEntity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CachedTrack" ADD CONSTRAINT "CachedTrack_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CachedTrack" ADD CONSTRAINT "CachedTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudiobookProgress" ADD CONSTRAINT "AudiobookProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastEpisode" ADD CONSTRAINT "PodcastEpisode_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastSubscription" ADD CONSTRAINT "PodcastSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastSubscription" ADD CONSTRAINT "PodcastSubscription_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastProgress" ADD CONSTRAINT "PodcastProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastProgress" ADD CONSTRAINT "PodcastProgress_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "PodcastEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastDownload" ADD CONSTRAINT "PodcastDownload_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PodcastDownload" ADD CONSTRAINT "PodcastDownload_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "PodcastEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoverExclusion" ADD CONSTRAINT "DiscoverExclusion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDiscoverConfig" ADD CONSTRAINT "UserDiscoverConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnavailableAlbum" ADD CONSTRAINT "UnavailableAlbum_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceLinkCode" ADD CONSTRAINT "DeviceLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

