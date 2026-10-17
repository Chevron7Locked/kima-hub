// Cut-offs on instrumentalness, acousticness, valence and arousal (read wholly or partly from the sound model and the
// mood analyzer) pass the same share of a library as before the music sound model and the mood analyzer's new
// valence/arousal mapping: each was matched on 8,971 tracks, recorded in
// services/audio-analyzer-clap/eval/music-switch-2026-10-17/cutoffs.json. A new model or mapping needs a new match.
import { Prisma } from "@prisma/client";
import { ProgrammaticMix, sampledMix, TRACK_LIMIT } from "./helpers";
import { NOT_MISSING } from "../../utils/libraryEligibility";

/** The days that have a mix, by day of week (0 = Sunday). */
const DAY_MIXES: Record<
    number,
    {
        id: string;
        type: string;
        name: string;
        description: string;
        colorType: string;
        where: Prisma.TrackWhereInput;
    }
> = {
    0: {
        id: "sunday",
        type: "sunday-morning",
        name: "Sunday Morning",
        description: "Peaceful tunes for a lazy Sunday",
        colorType: "sunday-morning",
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            energy: { lte: 0.5 },
            acousticness: { gte: 0.551 },
        },
    },
    1: {
        id: "monday",
        type: "confidence-boost",
        name: "Monday Motivation",
        description: "Start your week with energy",
        colorType: "confidence-boost",
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            energy: { gte: 0.6 },
            valence: { gte: 0.51 },
        },
    },
    5: {
        id: "friday",
        type: "dance-floor",
        name: "Friday Night",
        description: "Weekend vibes to kick off the party",
        colorType: "dance-floor",
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            danceability: { gte: 0.7 },
            energy: { gte: 0.6 },
        },
    },
};

export async function generateDayMix(
    _userId: string
): Promise<ProgrammaticMix | null> {
    const today = new Date().toISOString().split("T")[0];
    const day = DAY_MIXES[new Date().getDay()];
    if (!day) return null;

    return sampledMix({
        id: `${day.id}-${today}`,
        type: day.type,
        name: day.name,
        description: day.description,
        colorType: day.colorType,
        take: 100,
        minTracks: 15,
        limit: TRACK_LIMIT,
        where: day.where,
    });
}
