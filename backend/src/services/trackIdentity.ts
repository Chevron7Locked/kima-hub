import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { songLinkService, SongLinkResult } from "./songlink";
import { musicBrainzService } from "./musicbrainz";

interface ResolvedTrack {
    sourceUrl: string;
    platform: string | null;
    spotifyId: string | null;
    isrc: string | null;
    title: string;
    artist: string;
    album: string | null;
    genres: string[];
    tags: string[];
    coverUrl: string | null;
    songLinkData: SongLinkResult | null;
}

class TrackIdentityService {
    async resolveUrl(url: string): Promise<ResolvedTrack | null> {
        const platform = songLinkService.detectPlatform(url);

        let songLinkData: SongLinkResult | null = null;
        let spotifyId: string | null = null;
        let isrc: string | null = null;
        let title: string | null = null;
        let artist: string | null = null;
        let album: string | null = null;
        let coverUrl: string | null = null;

        songLinkData = await songLinkService.resolve(url);
        if (!songLinkData) return null;

        spotifyId = songLinkData.spotifyId;
        title = songLinkData.title;
        artist = songLinkData.artist;
        coverUrl = songLinkData.thumbnailUrl;

        if (!title || !artist) return null;

        // If we have a Spotify ID, fetch full metadata including ISRC
        if (spotifyId && !isrc) {
            try {
                const { spotifyService } = await import("./spotify");
                const trackData = await spotifyService.getTrackBySpotifyId(spotifyId);
                if (trackData) {
                    isrc = trackData.isrc;
                    album = trackData.album || album;
                    title = trackData.title || title;
                    artist = trackData.artist || artist;
                    coverUrl = trackData.coverUrl || coverUrl;
                }
            } catch (err) {
                logger.debug(`Could not fetch Spotify metadata for ${spotifyId}: ${err}`);
            }
        }

        // Resolve genres via MusicBrainz if ISRC available
        let genres: string[] = [];
        let tags: string[] = [];

        if (isrc) {
            try {
                const mbRecording = await musicBrainzService.lookupByIsrc(isrc);
                if (mbRecording) {
                    const genreData = await musicBrainzService.getRecordingGenres(mbRecording.recordingId);
                    if (genreData) {
                        genres = genreData.genres
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 5)
                            .map((g) => g.name);
                        tags = genreData.tags
                            .sort((a, b) => b.count - a.count)
                            .slice(0, 10)
                            .map((t) => t.name);
                    }
                }
            } catch (err) {
                logger.debug(`MusicBrainz genre lookup failed for ISRC ${isrc}: ${err}`);
            }
        }

        return {
            sourceUrl: url,
            platform,
            spotifyId,
            isrc,
            title,
            artist,
            album,
            genres,
            tags,
            coverUrl,
            songLinkData,
        };
    }

    async storeIsrc(trackId: string, isrc: string, source: string): Promise<void> {
        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: { isrc: true, isrcSource: true },
        });
        if (!track) return;

        const priority = ["id3", "spotify", "deezer", "musicbrainz", "songlink"];
        const existingIdx = track.isrcSource ? priority.indexOf(track.isrcSource) : -1;
        const existingPriority = existingIdx >= 0 ? existingIdx : priority.length;
        const newPriority = priority.indexOf(source);

        if (!track.isrc || (newPriority >= 0 && newPriority < existingPriority)) {
            await prisma.track.update({
                where: { id: trackId },
                data: { isrc, isrcSource: source },
            });
        }
    }

    async populateTrackGenres(trackId: string, genreNames: string[]): Promise<void> {
        if (genreNames.length === 0) return;

        await prisma.$transaction(async (tx) => {
            for (const name of genreNames) {
                const genre = await tx.genre.upsert({
                    where: { name },
                    create: { name },
                    update: {},
                });

                await tx.trackGenre.upsert({
                    where: { trackId_genreId: { trackId, genreId: genre.id } },
                    create: { trackId, genreId: genre.id },
                    update: {},
                });
            }
        });
    }

    async findTrackByIsrc(isrc: string): Promise<{
        id: string;
        title: string;
        albumId: string;
        albumTitle: string;
        artistName: string;
    } | null> {
        const track = await prisma.track.findFirst({
            where: { isrc, album: { location: "LIBRARY" } },
            include: {
                album: {
                    include: { artist: { select: { name: true } } },
                },
            },
        });
        if (!track) return null;
        return {
            id: track.id,
            title: track.title,
            albumId: track.albumId,
            albumTitle: track.album.title,
            artistName: track.album.artist.name,
        };
    }
}

export const trackIdentityService = new TrackIdentityService();
