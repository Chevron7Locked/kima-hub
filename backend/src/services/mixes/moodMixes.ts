// Vocal Detox's instrumental cut-off is its launch value; the record is
// services/audio-analyzer-clap/eval/music-switch-2026-10-17/cutoffs.json.
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    ProgrammaticMix,
    albumCoverUrls,
    getMixColor,
    randomSample,
    sampledMix,
    sampleTracks,
    drawIds,
    tracksByIds,
    unplayedTrackIds,
    sampleMix,
    getSeededRandom,
    seededShuffle,
} from "./helpers";
import { recipeMixGenerator } from "./recipeMix";
import { STEADY_BEAT } from "./recipes";
import { NOT_MISSING } from "../../utils/libraryEligibility";
import { spellingsOf } from "../stats/playable";
import type { MoodType } from "../moodBucketService";

const MIN_TRACKS_DAILY = 8;
const WEEKLY_TRACK_LIMIT = 20;

// MOOD MIXES: each draws from its recipe in recipes.json

export const generateChillMix = recipeMixGenerator({
    recipe: "chill", id: "chill", type: "chill", name: "Chill Mix",
    description: "Relax and unwind with mellow vibes", colorType: "chill",
});

export const generateHighEnergyMix = recipeMixGenerator({
    recipe: "high-energy", id: "high-energy", type: "workout", name: "High Energy",
    description: "Fast-paced tracks to get you moving", colorType: "workout",
});

export const generateLateNightMix = recipeMixGenerator({
    recipe: "late-night", id: "late-night", type: "late-night", name: "Late Night",
    description: "Mellow vibes for the quiet hours", colorType: "late-night",
});

export const generateHappyMix = recipeMixGenerator({
    recipe: "happy", id: "happy", type: "happy", name: "Happy Vibes",
    description: "Feel-good tracks to brighten your day", colorType: "happy",
});

export const generateMelancholyMix = recipeMixGenerator({
    recipe: "melancholy", id: "melancholy", type: "melancholy", name: "Melancholy",
    description: "Introspective tracks for reflective moments", colorType: "melancholy",
});

export const generateDanceFloorMix = recipeMixGenerator({
    recipe: "dance-floor", id: "dance-floor", type: "dance-floor", name: "Dance Floor",
    description: "High danceability tracks with perfect tempo", colorType: "dance-floor",
});

export const generateAcousticMix = recipeMixGenerator({
    recipe: "acoustic", id: "acoustic", type: "acoustic", name: "Acoustic Afternoon",
    description: "Stripped-down, organic sounds", colorType: "acoustic",
});

export const generateInstrumentalMix = recipeMixGenerator({
    recipe: "instrumental", id: "instrumental", type: "instrumental", name: "Instrumental Focus",
    description: "No vocals, pure concentration", colorType: "instrumental",
});

export const generateRoadTripMix = recipeMixGenerator({
    recipe: "road-trip", id: "road-trip", type: "road-trip", name: "Road Trip",
    description: "Perfect soundtrack for the open road", colorType: "road-trip",
});

export const generateSadGirlSundays = recipeMixGenerator({
    recipe: "sad-girl-sundays", id: "sad-girl-sundays", type: "sad-girl-sundays", name: "Sad Girl Sundays",
    description: "Melancholic introspection and feelings", colorType: "sad-girl-sundays", day: 0,
});

export const generateMainCharacterEnergy = recipeMixGenerator({
    recipe: "main-character", id: "main-character", type: "main-character", name: "Main Character Energy",
    description: "You're the protagonist today", colorType: "main-character",
});

export const generateVillainEra = recipeMixGenerator({
    recipe: "villain-era", id: "villain-era", type: "villain-era", name: "Villain Era",
    description: "Embrace your dark side", colorType: "villain-era",
});

export const generate3AMThoughts = recipeMixGenerator({
    recipe: "3am-thoughts", id: "3am-thoughts", type: "3am-thoughts", name: "3AM Thoughts",
    description: "Late night overthinking companion", colorType: "3am-thoughts",
});

export const generateHotGirlWalk = recipeMixGenerator({
    recipe: "hot-girl-walk", id: "hot-girl-walk", type: "hot-girl-walk", name: "Hot Girl Walk",
    description: "Confidence boost for your walk", colorType: "confidence-boost",
});

export const generateRageCleaning = recipeMixGenerator({
    recipe: "rage-cleaning", id: "rage-cleaning", type: "rage-cleaning", name: "Rage Cleaning",
    description: "Aggressive productivity fuel", colorType: "workout",
});

export const generateGoldenHour = recipeMixGenerator({
    recipe: "golden-hour", id: "golden-hour", type: "golden-hour", name: "Golden Hour",
    description: "Warm sunset vibes", colorType: "golden-hour",
});

export const generateShowerKaraoke = recipeMixGenerator({
    recipe: "shower-karaoke", id: "shower-karaoke", type: "shower-karaoke", name: "Shower Karaoke",
    description: "Belters you can't help but sing", colorType: "happy",
});

export const generateInMyFeelings = recipeMixGenerator({
    recipe: "in-my-feelings", id: "in-my-feelings", type: "in-my-feelings", name: "In My Feelings",
    description: "Let it all out", colorType: "heartbreak-hotel",
});

export const generateMidnightDrive = recipeMixGenerator({
    recipe: "midnight-drive", id: "midnight-drive", type: "midnight-drive", name: "Midnight Drive",
    description: "Perfect for late night cruising", colorType: "night-drive",
});

export const generateCoffeeShopVibes = recipeMixGenerator({
    recipe: "coffee-shop", id: "coffee-shop", type: "coffee-shop", name: "Coffee Shop Vibes",
    description: "Cozy background music", colorType: "coffee-shop",
});

export const generateRomanticizeYourLife = recipeMixGenerator({
    recipe: "romanticize", id: "romanticize", type: "romanticize", name: "Romanticize Your Life",
    description: "Make every moment aesthetic", colorType: "golden-hour",
});

export const generateThatGirlEra = recipeMixGenerator({
    recipe: "that-girl-era", id: "that-girl-era", type: "that-girl-era", name: "That Girl Era",
    description: "Self-improvement mode activated", colorType: "confidence-boost",
});

export const generateUnhinged = recipeMixGenerator({
    recipe: "unhinged", id: "unhinged", type: "unhinged", name: "Unhinged",
    description: "Embrace the chaos", colorType: "dance-floor",
});

export const generateSleepMix = recipeMixGenerator({
    recipe: "sleep", id: "sleep", type: "sleep", name: "Sleep",
    description: "Slow, quiet tracks to drift off to", colorType: "late-night",
});

export const generateSummerMix = recipeMixGenerator({
    recipe: "summer", id: "summer", type: "summer", name: "Summer",
    description: "Sunny, carefree tracks for warm days", colorType: "summer-vibes",
});

export const generateEpicMix = recipeMixGenerator({
    recipe: "epic", id: "epic", type: "epic", name: "Epic",
    description: "Big, soaring tracks that feel like a movie", colorType: "main-character",
});

export const generateDreamyMix = recipeMixGenerator({
    recipe: "dreamy", id: "dreamy", type: "dreamy", name: "Dreamy",
    description: "Hazy, floating tracks to get lost in", colorType: "3am-thoughts",
});

export const generateNostalgicMix = recipeMixGenerator({
    recipe: "nostalgic", id: "nostalgic", type: "nostalgic", name: "Nostalgic",
    description: "Tracks that take you back", colorType: "throwback",
});

// WEEKLY CURATED MIXES (20 tracks)

export async function generateDeepCuts(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await tracksByIds(
        drawIds(await unplayedTrackIds({ excludeMissing: true }), 200),
        {
            album: {
                select: {
                    coverUrl: true,
                    artist: { select: { id: true } },
                },
            },
        }
    );

    if (tracks.length < 15) {
        const playCounts = await prisma.track.findMany({
            where: NOT_MISSING,
            select: { id: true, _count: { select: { plays: true } } },
            orderBy: { id: "asc" },
        });
        const lowPlayIds = playCounts
            .filter((t) => t._count.plays <= 3)
            .map((t) => t.id);

        const filtered = await tracksByIds(drawIds(lowPlayIds, 200), {
            album: { select: { coverUrl: true } },
        });

        if (filtered.length < 15) return null;

        return sampleMix(
            {
                id: `deep-cuts-${today}`,
                type: "deep-cuts",
                name: "Deep Cuts",
                description: "Hidden gems waiting to be discovered",
                colorType: "rediscover",
            },
            filtered,
            WEEKLY_TRACK_LIMIT
        );
    }

    return sampleMix(
        {
            id: `deep-cuts-${today}`,
            type: "deep-cuts",
            name: "Deep Cuts",
            description: "Hidden gems waiting to be discovered",
            colorType: "rediscover",
        },
        tracks,
        WEEKLY_TRACK_LIMIT
    );
}

export async function generateKeyJourney(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const keyOrder = [
        "C",
        "G",
        "D",
        "A",
        "E",
        "B",
        "F#",
        "Db",
        "Ab",
        "Eb",
        "Bb",
        "F",
    ];

    const tracks = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            key: { not: null },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 200,
        seed: getSeededRandom(`key-journey-${today}`),
    });

    if (tracks.length < 15) return null;

    const byKey = new Map<string, typeof tracks>();
    for (const track of tracks) {
        // Essentia writes C# where keyOrder says Db; group by the table's spelling.
        const key = spellingsOf(track.key || "C").find((s) => keyOrder.includes(s)) ?? track.key ?? "C";
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(track);
    }

    const journey: typeof tracks = [];

    for (const key of keyOrder) {
        const keyTracks = byKey.get(key) || [];
        if (keyTracks.length > 0 && journey.length < WEEKLY_TRACK_LIMIT) {
            const count = Math.min(
                2,
                keyTracks.length,
                WEEKLY_TRACK_LIMIT - journey.length
            );
            const keySeed = getSeededRandom(`key-journey-${today}-${key}`);
            const shuffled = seededShuffle(keyTracks, keySeed);
            journey.push(...shuffled.slice(0, count));
        }
    }

    if (journey.length < 15) return null;

    const coverUrls = albumCoverUrls(journey);

    return {
        id: `key-journey-${today}`,
        type: "key-journey",
        name: "Key Journey",
        description: "Harmonic progression through your library",
        trackIds: journey.map((t) => t.id),
        coverUrls,
        trackCount: journey.length,
        color: getMixColor("instrumental"),
    };
}

export async function generateTempoFlow(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await sampleTracks({
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            bpm: { not: null },
            // A tempo the extractor is unsure of would put the song in the wrong band.
            bpmConfidence: { gte: STEADY_BEAT },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 200,
    });

    if (tracks.length < 15) return null;

    const sorted = [...tracks].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));

    const slow = sorted.filter((t) => (t.bpm || 0) < 100);
    const medium = sorted.filter(
        (t) => (t.bpm || 0) >= 100 && (t.bpm || 0) < 130
    );
    const fast = sorted.filter((t) => (t.bpm || 0) >= 130);

    const flow: typeof tracks = [];

    flow.push(...randomSample(slow, Math.min(4, slow.length)));
    flow.push(...randomSample(medium, Math.min(5, medium.length)));
    flow.push(...randomSample(fast, Math.min(6, fast.length)));
    flow.push(
        ...randomSample(
            medium.filter((t) => !flow.includes(t)),
            Math.min(3, medium.length)
        )
    );
    flow.push(
        ...randomSample(
            slow.filter((t) => !flow.includes(t)),
            Math.min(2, slow.length)
        )
    );

    if (flow.length < 15) return null;

    const coverUrls = albumCoverUrls(flow);

    return {
        id: `tempo-flow-${today}`,
        type: "tempo-flow",
        name: "Tempo Flow",
        description: "An energy journey through BPM",
        trackIds: flow.slice(0, WEEKLY_TRACK_LIMIT).map((t) => t.id),
        coverUrls,
        trackCount: Math.min(flow.length, WEEKLY_TRACK_LIMIT),
        color: getMixColor("workout"),
    };
}

export async function generateVocalDetox(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    return sampledMix({
        id: `vocal-detox-${today}`,
        type: "vocal-detox",
        name: "Vocal Detox",
        description: "Pure instrumental escape",
        colorType: "instrumental",
        take: 100,
        minTracks: 15,
        limit: WEEKLY_TRACK_LIMIT,
        seed: getSeededRandom(`vocal-detox-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            instrumentalness: { gte: 0.75 },
        },
    });
}

export async function generateMinorKeyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 1) return null;

    // Felt energy (arousal) in the upper half of this library, whatever level the library sits at.
    const [{ median }] = await prisma.$queryRaw<Array<{ median: number | null }>>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY arousal) AS median
        FROM "Track"
        WHERE "missingSince" IS NULL AND "analysisStatus" = 'completed' AND arousal IS NOT NULL
    `;
    if (median === null) return null;

    return sampledMix({
        id: `minor-key-${today}`,
        type: "melancholy",
        name: "Minor Key Mondays",
        description: "All minor key bangers",
        colorType: "melancholy",
        take: 100,
        minTracks: 15,
        limit: WEEKLY_TRACK_LIMIT,
        seed: getSeededRandom(`minor-key-${today}`),
        where: {
            ...NOT_MISSING,
            analysisStatus: "completed",
            keyScale: "minor",
            arousal: { gte: median },
        },
    });
}

export type MoodOnDemandParams = {
    mood?: MoodType;
    valence?: { min?: number; max?: number };
    energy?: { min?: number; max?: number };
    danceability?: { min?: number; max?: number };
    acousticness?: { min?: number; max?: number };
    instrumentalness?: { min?: number; max?: number };
    arousal?: { min?: number; max?: number };
    bpm?: { min?: number; max?: number };
    keyScale?: "major" | "minor";
    moodHappy?: { min?: number; max?: number };
    moodSad?: { min?: number; max?: number };
    moodRelaxed?: { min?: number; max?: number };
    moodAggressive?: { min?: number; max?: number };
    moodParty?: { min?: number; max?: number };
    limit?: number;
};

export async function generateMoodOnDemand(
    _userId: string,
    params: MoodOnDemandParams
): Promise<ProgrammaticMix | null> {
    const where: any = {
        analysisStatus: "completed",
        ...NOT_MISSING,
    };

    // Mood path: the named mood selects the bucket pool — the
    // head verdict is the membership, no score cutoffs. Legacy callers pass
    // the head columns (moodHappy: { min: … }); they name the same mood and
    // their thresholds are ignored.
    const LEGACY_MOOD_PARAMS: [string, MoodType][] = [
        ["moodHappy", "happy"],
        ["moodSad", "sad"],
        ["moodRelaxed", "chill"],
        ["moodAggressive", "aggressive"],
        ["moodParty", "party"],
    ];
    const mood =
        params.mood ??
        LEGACY_MOOD_PARAMS.find(([key]) => (params as any)[key] !== undefined)
            ?.[1];
    for (const [key] of LEGACY_MOOD_PARAMS) delete (params as any)[key];
    if (mood) {
        const bucketSize = await prisma.moodBucket.count({ where: { mood } });
        if (bucketSize < MIN_TRACKS_DAILY) {
            logger.debug(
                `[MoodMixer] Bucket "${mood}" has ${bucketSize} tracks (need ${MIN_TRACKS_DAILY})`
            );
            return null;
        }
        where.moodBuckets = { some: { mood } };
    }

    if (params.valence) {
        where.valence = where.valence || {};
        if (params.valence.min !== undefined)
            where.valence.gte = Math.max(
                where.valence.gte || 0,
                params.valence.min
            );
        if (params.valence.max !== undefined)
            where.valence.lte = Math.min(
                where.valence.lte ?? 1,
                params.valence.max
            );
    }
    if (params.energy) {
        where.energy = where.energy || {};
        if (params.energy.min !== undefined)
            where.energy.gte = Math.max(
                where.energy.gte || 0,
                params.energy.min
            );
        if (params.energy.max !== undefined)
            where.energy.lte = Math.min(
                where.energy.lte ?? 1,
                params.energy.max
            );
    }
    if (params.danceability) {
        where.danceability = where.danceability || {};
        if (params.danceability.min !== undefined)
            where.danceability.gte = Math.max(
                where.danceability.gte || 0,
                params.danceability.min
            );
        if (params.danceability.max !== undefined)
            where.danceability.lte = Math.min(
                where.danceability.lte ?? 1,
                params.danceability.max
            );
    }
    if (params.acousticness) {
        where.acousticness = {};
        if (params.acousticness.min !== undefined)
            where.acousticness.gte = params.acousticness.min;
        if (params.acousticness.max !== undefined)
            where.acousticness.lte = params.acousticness.max;
    }
    if (params.instrumentalness) {
        where.instrumentalness = {};
        if (params.instrumentalness.min !== undefined)
            where.instrumentalness.gte = params.instrumentalness.min;
        if (params.instrumentalness.max !== undefined)
            where.instrumentalness.lte = params.instrumentalness.max;
    }
    if (params.arousal) {
        where.arousal = {};
        if (params.arousal.min !== undefined)
            where.arousal.gte = params.arousal.min;
        if (params.arousal.max !== undefined)
            where.arousal.lte = params.arousal.max;
    }
    if (params.bpm) {
        where.bpm = {};
        if (params.bpm.min !== undefined) where.bpm.gte = params.bpm.min;
        if (params.bpm.max !== undefined) where.bpm.lte = params.bpm.max;
    }
    if (params.keyScale) {
        where.keyScale = params.keyScale;
    }

    const tracks = await sampleTracks({
        where,
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    const limit = params.limit || 15;
    if (tracks.length < Math.min(limit, 8)) return null;

    const shuffled = randomSample(tracks, limit);
    const coverUrls = albumCoverUrls(shuffled);

    const timestamp = Date.now();
    return {
        id: `mood-on-demand-${timestamp}`,
        type: "mood-on-demand",
        name: "Custom Mood Mix",
        description: "Generated just for you",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("mood"),
    };
}
