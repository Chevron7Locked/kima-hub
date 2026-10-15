import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { songLinkService, SongLinkResult } from "./songlink";
import { musicBrainzService } from "./musicbrainz";
import { topVoted } from "../utils/votes";
import { pickRecording } from "./recordingMatch";
import { failureCause } from "../utils/outcome";
import { LIBRARY_LOCATION } from "./libraryFilters";

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

        const songLinkData = await songLinkService.resolve(url);
        if (!songLinkData) return null;

        const spotifyId = songLinkData.spotifyId;
        let title = songLinkData.title;
        let artist = songLinkData.artist;
        let album: string | null = null;
        let isrc: string | null = null;
        let coverUrl = songLinkData.thumbnailUrl;

        if (!title || !artist) return null;

        // If we have a Spotify ID, fetch full metadata including ISRC
        if (spotifyId) {
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
            const mbRecording = await musicBrainzService.lookupRecordingsByIsrc(isrc);
            const recording =
                mbRecording.kind === "answered"
                    ? pickRecording(mbRecording.value, { title, artists: [artist], durationSec: null })
                    : null;
            if (recording) {
                const genreData = await musicBrainzService.getRecordingGenres(recording.id);
                if (genreData.kind === "answered") {
                    genres = topVoted(genreData.value.genres, 5);
                    tags = topVoted(genreData.value.tags, 10);
                } else if (genreData.kind !== "absent") {
                    logger.debug(
                        `MusicBrainz genre lookup ${genreData.kind} for ISRC ${isrc}: ${failureCause(genreData)}`
                    );
                }
            } else if (mbRecording.kind !== "absent" && mbRecording.kind !== "answered") {
                logger.debug(
                    `ISRC lookup ${mbRecording.kind} for ${isrc}: ${failureCause(mbRecording)}`
                );
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

    /**
     * The track's genres are its identified recording's: this set replaces whatever an earlier answer left.
     * Songs of one album finish together with the same new genres: inserts skip duplicates, waiting for a
     * genre another song is creating, and go in name order so two songs never wait on each other.
     */
    async populateTrackGenres(trackId: string, genreNames: string[]): Promise<void> {
        const names = [...new Set(genreNames)].sort();
        await prisma.$transaction(async (tx) => {
            if (names.length > 0) {
                await tx.genre.createMany({ data: names.map((name) => ({ name })), skipDuplicates: true });
            }
            const genres = names.length > 0
                ? await tx.genre.findMany({ where: { name: { in: names } }, select: { id: true } })
                : [];
            const ids = genres.map((g) => g.id);
            if (ids.length > 0) {
                await tx.trackGenre.createMany({
                    data: ids.map((genreId) => ({ trackId, genreId })),
                    skipDuplicates: true,
                });
            }
            await tx.trackGenre.deleteMany({ where: { trackId, genreId: { notIn: ids } } });
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
            where: { isrc, album: { location: LIBRARY_LOCATION } },
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
