import { prisma } from "../../utils/db";
import { ProgrammaticMix, getMixColor, randomSample } from "./helpers";

const TRACK_LIMIT = 20;

export async function generateDayMix(
    userId: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    const today = new Date().toISOString().split("T")[0];

    switch (dayOfWeek) {
        case 0:
            return generateSundayMix(userId, today);
        case 1:
            return generateMondayMix(userId, today);
        case 5:
            return generateFridayMix(userId, today);
        default:
            return null;
    }
}

export async function generateSundayMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                {
                    analysisStatus: "completed",
                    energy: { lte: 0.5 },
                    acousticness: { gte: 0.5 },
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "relaxed",
                            "calm",
                            "peaceful",
                            "chill",
                            "sunday",
                        ],
                    },
                },
            ],
        },
        include: {
            album: { select: { coverUrl: true } },
        },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `sunday-${today}`,
        type: "sunday-morning",
        name: "Sunday Morning",
        description: "Peaceful tunes for a lazy Sunday",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("sunday-morning"),
    };
}

export async function generateMondayMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                {
                    analysisStatus: "completed",
                    energy: { gte: 0.6 },
                    valence: { gte: 0.5 },
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "motivation",
                            "uplifting",
                            "energetic",
                            "happy",
                        ],
                    },
                },
            ],
        },
        include: {
            album: { select: { coverUrl: true } },
        },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `monday-${today}`,
        type: "confidence-boost",
        name: "Monday Motivation",
        description: "Start your week with energy",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("confidence-boost"),
    };
}

export async function generateFridayMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                {
                    analysisStatus: "completed",
                    danceability: { gte: 0.7 },
                    energy: { gte: 0.6 },
                },
                {
                    lastfmTags: {
                        hasSome: ["party", "dance", "fun", "groovy"],
                    },
                },
            ],
        },
        include: {
            album: { select: { coverUrl: true } },
        },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `friday-${today}`,
        type: "dance-floor",
        name: "Friday Night",
        description: "Weekend vibes to kick off the party",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("dance-floor"),
    };
}
