import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { normalizeArtistName } from "../artistIdentity";
import { MIN_MIX_TRACKS, albumArtistSql, capByArtist } from "./artistCap";
import { getSimilarArtists } from "../artistSimilarity";
import { LIBRARY_LOCATION } from "../libraryFilters";
import { IN_LIBRARY, NOT_MISSING } from "../../utils/libraryEligibility";
import {
    ProgrammaticMix,
    albumCoverUrls,
    sampleMix,
    MIX_SONG_ALBUM,
    getMixColor,
    getSeededRandom,
    seededKeySql,
    seededOrder,
    seededTrackIds,
    tracksByIds,
    TRACK_LIMIT,
} from "./helpers";

export async function generateTopTracksMix(
    userId: string
): Promise<ProgrammaticMix | null> {
    const playStats = await prisma.play.groupBy({
        by: ["trackId"],
        where: { userId, track: { ...NOT_MISSING, ...IN_LIBRARY } },
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
        where: { id: { in: trackIds }, ...NOT_MISSING, ...IN_LIBRARY },
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
    // The library's songs this listener has played two times or fewer: every song but the few played more, looked up
    // in one hashed list (counting each song's plays instead took 2.2 s at 500,000 songs).
    const underplayedIds = await seededTrackIds(
        Prisma.sql`a.location = ${LIBRARY_LOCATION}::"AlbumLocation"
                   AND t.id NOT IN (SELECT p."trackId" FROM "Play" p WHERE p."userId" = ${userId}
                                    GROUP BY p."trackId" HAVING count(*) > 2)`,
        200,
        getSeededRandom(`rediscover-${today}`)
    );
    if (underplayedIds.length < 5) return null;

    const underplayedTracks = await tracksByIds(underplayedIds, { album: { select: { coverUrl: true } } });
    // Already in the day's order: seededTrackIds ranks by the seed, and tracksByIds keeps the order it is given.
    const selectedTracks = underplayedTracks.slice(0, TRACK_LIMIT);
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
            track: IN_LIBRARY,
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
                    where: { location: "LIBRARY" },
                    include: {
                        tracks: {
                            where: NOT_MISSING,
                            include: { album: MIX_SONG_ALBUM },
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
    // The day's albums: in the day's order, the first album by each artist (a compilation by no one is its own), ten of
    // them, so the mix's 20 songs at 2 per artist come from ten artists. None when the library has fewer than ten.
    const key = seededKeySql(getSeededRandom(`random-${today}`), Prisma.sql`a.id`);
    const drawn = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM (
            SELECT a.id, ${key} AS k, row_number() OVER (PARTITION BY ${albumArtistSql()} ORDER BY ${key}) AS n
            FROM "Album" a
            JOIN "Artist" ar ON ar.id = a."artistId"
            WHERE a.location = 'LIBRARY'
              AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id AND t."missingSince" IS NULL)
        ) ranked
        WHERE n = 1
        ORDER BY k
        LIMIT 10
    `;
    if (drawn.length < 10) return null;

    const albumIds = drawn.map((a) => a.id);
    const drawnAlbums = await prisma.album.findMany({
        where: { id: { in: albumIds } },
        include: {
            tracks: {
                where: NOT_MISSING,
                include: { album: MIX_SONG_ALBUM },
            },
        },
    });
    const randomAlbums = albumIds.flatMap((id) => drawnAlbums.filter((a) => a.id === id));

    const tracks = randomAlbums.flatMap((album) => album.tracks);

    // 2 songs per album: each album is a different artist, and a compilation, whose songs are each their own artist,
    // takes no more room than the others.
    const ordered = seededOrder(tracks, getSeededRandom(`random-discovery-${today}`), (t) => t.id);
    const byId = new Map(ordered.map((t) => [t.id, t]));
    const selectedTracks = capByArtist(ordered.map((t) => ({ id: t.id, artistId: t.albumId })), TRACK_LIMIT).map((id) => byId.get(id)!);
    if (selectedTracks.length < MIN_MIX_TRACKS) return null;
    const coverUrls = albumCoverUrls(selectedTracks);

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
