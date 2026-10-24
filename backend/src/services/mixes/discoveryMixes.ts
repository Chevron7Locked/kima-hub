import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { normalizeArtistName } from "../artistIdentity";
import { getSimilarArtists } from "../artistSimilarity";
import { LIBRARY_LOCATION } from "../libraryFilters";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import {
    ProgrammaticMix,
    albumCoverUrls,
    sampleMix,
    getMixColor,
    getSeededRandom,
    seededShuffle,
    drawIds,
    tracksByIds,
    TRACK_LIMIT,
} from "./helpers";

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
        where: { id: { in: trackIds }, ...NOT_MISSING },
        include: {
            album: { select: { coverUrl: true } },
        },
    });

    const orderedTracks = trackIds
        .map((id) => tracks.find((t) => t.id === id))
        .filter((t) => t !== undefined);

    const coverUrls = albumCoverUrls(orderedTracks);

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
    const playCounts = await prisma.track.findMany({
        where: {
            ...NOT_MISSING,
            album: { location: LIBRARY_LOCATION },
        },
        select: {
            id: true,
            _count: {
                select: {
                    plays: { where: { userId } },
                },
            },
        },
        orderBy: { id: "asc" },
    });

    const underplayedIds = playCounts
        .filter((t) => t._count.plays <= 2)
        .map((t) => t.id);

    if (underplayedIds.length < 5) return null;

    const seed = getSeededRandom(`rediscover-${today}`);
    const underplayedTracks = await tracksByIds(
        drawIds(underplayedIds, 200, seed),
        { album: { select: { coverUrl: true } } }
    );
    const shuffled = seededShuffle(underplayedTracks, seed);

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = albumCoverUrls(selectedTracks);

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
        const similarArtists = await getSimilarArtists(
            topArtist.mbid || "",
            topArtist.name,
            10
        );

        logger.debug(
            `[ARTIST SIMILAR MIX] similarity source returned ${similarArtists.length} similar artists`
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
                            where: NOT_MISSING,
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

        return sampleMix(
            {
                id: `artist-similar-${topArtistId}`,
                type: "artist-similar",
                name: `More Like ${topArtist.name}`,
                description: `Similar artists you might enjoy`,
                colorType: "artist-similar",
            },
            tracks,
            TRACK_LIMIT
        );
    } catch (error) {
        logger.error("Failed to generate artist similar mix:", error);
        return null;
    }
}

export async function generateRandomDiscoveryMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const eligibleAlbums = await prisma.album.findMany({
        where: { tracks: { some: NOT_MISSING } },
        select: { id: true },
        orderBy: { id: "asc" },
    });

    if (eligibleAlbums.length < 10) return null;

    const albumIds = drawIds(
        eligibleAlbums.map((a) => a.id),
        5,
        getSeededRandom(`random-${today}`)
    );
    const drawnAlbums = await prisma.album.findMany({
        where: { id: { in: albumIds } },
        include: {
            tracks: {
                where: NOT_MISSING,
                include: {
                    album: { select: { coverUrl: true } },
                },
            },
        },
    });
    const randomAlbums = albumIds.flatMap((id) => drawnAlbums.filter((a) => a.id === id));

    // In id order first, so the day's shuffle does not depend on the order the database returns an album's tracks in.
    const tracks = randomAlbums.flatMap((album) => album.tracks).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (tracks.length < 5) return null;

    const selectedTracks = seededShuffle(tracks, getSeededRandom(`random-discovery-${today}`)).slice(0, TRACK_LIMIT);
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
