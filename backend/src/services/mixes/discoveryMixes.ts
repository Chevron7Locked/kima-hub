import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { normalizeArtistName } from "../../utils/artistNormalization";
import { lastFmService } from "../lastfm";
import {
    ProgrammaticMix,
    getMixColor,
    randomSample,
    getSeededRandom,
} from "./helpers";

const TRACK_LIMIT = 20;

export async function generateTopTracksMix(
    userId: string
): Promise<ProgrammaticMix | null> {
    const playStats = await prisma.play.groupBy({
        by: ["trackId"],
        where: { userId },
        _count: { trackId: true },
        orderBy: { _count: { trackId: "desc" } },
        take: TRACK_LIMIT,
    });

    logger.debug(
        `[TOP TRACKS MIX] Found ${playStats.length} unique played tracks`
    );
    if (playStats.length < 5) {
        logger.debug(
            `[TOP TRACKS MIX] FAILED: Only ${playStats.length} tracks (need at least 5)`
        );
        return null;
    }

    const trackIds = playStats.map((p) => p.trackId);
    const tracks = await prisma.track.findMany({
        where: { id: { in: trackIds } },
        include: {
            album: { select: { coverUrl: true } },
        },
    });

    const orderedTracks = trackIds
        .map((id) => tracks.find((t) => t.id === id))
        .filter((t) => t !== undefined);

    const coverUrls = orderedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: "top-tracks",
        type: "top-tracks",
        name: "Your Top 20",
        description: "Your most played tracks",
        trackIds: orderedTracks.map((t) => t.id),
        coverUrls,
        trackCount: orderedTracks.length,
        color: getMixColor("top-tracks"),
    };
}

export async function generateRediscoverMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const allTracks = await prisma.track.findMany({
        where: {
            album: { location: "LIBRARY" },
        },
        take: 5000,
        include: {
            _count: {
                select: {
                    plays: { where: { userId } },
                },
            },
            album: { select: { coverUrl: true } },
        },
    });

    const underplayedTracks = allTracks.filter((t) => t._count.plays <= 2);

    if (underplayedTracks.length < 5) return null;

    const seed = getSeededRandom(`rediscover-${today}`);
    let random = seed;
    const shuffled = underplayedTracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `rediscover-${today}`,
        type: "rediscover",
        name: "Rediscover",
        description: "Hidden gems you rarely play",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("rediscover"),
    };
}

export async function generateArtistSimilarMix(
    userId: string
): Promise<ProgrammaticMix | null> {
    const recentPlays = await prisma.play.findMany({
        where: {
            userId,
            playedAt: {
                gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
        },
        include: {
            track: {
                include: {
                    album: { select: { artistId: true } },
                },
            },
        },
    });

    logger.debug(
        `[ARTIST SIMILAR MIX] Found ${recentPlays.length} plays in last 7 days`
    );
    if (recentPlays.length === 0) {
        logger.debug(`[ARTIST SIMILAR MIX] FAILED: No plays in last 7 days`);
        return null;
    }

    const artistPlayCounts = new Map<string, number>();
    recentPlays.forEach((play) => {
        const artistId = play.track.album.artistId;
        artistPlayCounts.set(
            artistId,
            (artistPlayCounts.get(artistId) || 0) + 1
        );
    });

    const topArtistId = Array.from(artistPlayCounts.entries()).sort(
        (a, b) => b[1] - a[1]
    )[0][0];

    const topArtist = await prisma.artist.findUnique({
        where: { id: topArtistId },
    });

    if (!topArtist || !topArtist.name) {
        logger.debug(
            `[ARTIST SIMILAR MIX] FAILED: Top artist not found or has no name`
        );
        return null;
    }

    logger.debug(`[ARTIST SIMILAR MIX] Top artist: ${topArtist.name}`);

    try {
        const similarArtists = await lastFmService.getSimilarArtists(
            topArtist.mbid || "",
            topArtist.name,
            10
        );

        logger.debug(
            `[ARTIST SIMILAR MIX] Last.fm returned ${similarArtists.length} similar artists`
        );

        const similarArtistNormalized = similarArtists.map((a) =>
            normalizeArtistName(a.name)
        );
        const artistsInLibrary = await prisma.artist.findMany({
            where: { normalizedName: { in: similarArtistNormalized } },
            include: {
                albums: {
                    include: {
                        tracks: {
                            include: {
                                album: { select: { coverUrl: true } },
                            },
                        },
                    },
                },
            },
        });

        logger.debug(
            `[ARTIST SIMILAR MIX] Found ${artistsInLibrary.length} similar artists in library`
        );

        const tracks = artistsInLibrary.flatMap((artist) =>
            artist.albums.flatMap((album) => album.tracks)
        );

        logger.debug(
            `[ARTIST SIMILAR MIX] Total tracks from similar artists: ${tracks.length}`
        );

        if (tracks.length < 5) {
            logger.debug(
                `[ARTIST SIMILAR MIX] FAILED: Only ${tracks.length} tracks (need at least 5)`
            );
            return null;
        }

        const selectedTracks = randomSample(tracks, TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `artist-similar-${topArtistId}`,
            type: "artist-similar",
            name: `More Like ${topArtist.name}`,
            description: `Similar artists you might enjoy`,
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("artist-similar"),
        };
    } catch (error) {
        logger.error("Failed to generate artist similar mix:", error);
        return null;
    }
}

export async function generateRandomDiscoveryMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const totalAlbums = await prisma.album.count({
        where: { tracks: { some: {} } },
    });

    if (totalAlbums < 10) return null;

    const seed = getSeededRandom(`random-${today}`) % totalAlbums;

    const randomAlbums = await prisma.album.findMany({
        where: { tracks: { some: {} } },
        include: {
            tracks: {
                include: {
                    album: { select: { coverUrl: true } },
                },
            },
        },
        skip: seed,
        take: 5,
    });

    const tracks = randomAlbums.flatMap((album) => album.tracks);
    if (tracks.length < 5) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = randomAlbums
        .filter((a) => a.coverUrl)
        .slice(0, 4)
        .map((a) => a.coverUrl!);

    return {
        id: `random-discovery-${today}`,
        type: "discovery",
        name: "Random Discovery",
        description: "Random albums to explore today",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("discovery"),
    };
}
