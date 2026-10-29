import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { nightMixGenerator } from "./nightPlays";
import {
    ProgrammaticMix,
    albumCoverUrls,
    getMixColor,
    sampledMix,
    seededTracks,
    getSeededRandom,
    seededOrder,
} from "./helpers";
import { recipeMixGenerator } from "./recipeMix";
import { weekdayOf } from "./mixDay";
import { STEADY_BEAT } from "./recipes";
import { spellingsOf } from "../stats/playable";

const WEEKLY_TRACK_LIMIT = 20;

// Each draws from its recipe in recipes.json.
export const generateChillMix = recipeMixGenerator({
    recipe: "chill", id: "chill", type: "chill", name: "Chill Mix",
    description: "Relax and unwind with mellow vibes", colorType: "chill",
});

export const generateHighEnergyMix = recipeMixGenerator({
    recipe: "high-energy", id: "high-energy", type: "workout", name: "High Energy",
    description: "Fast-paced tracks to get you moving", colorType: "workout",
});

/** The songs this listener plays after dark (nightPlays.ts); the recipe is its cold-start fallback. */
export const generateLateNightMix = nightMixGenerator({
    recipe: "late-night", id: "late-night", type: "late-night", name: "Late Night",
    description: "The songs you play after dark", colorType: "late-night", ranking: "plays",
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

/** The listener's night songs ranked toward a steady beat at a middle pace and energy (nightPlays.ts). */
export const generateMidnightDrive = nightMixGenerator({
    recipe: "midnight-drive", id: "midnight-drive", type: "midnight-drive", name: "Midnight Drive",
    description: "Your night songs that keep a steady pace", colorType: "night-drive", ranking: "drive",
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

export async function generateDeepCuts(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const spec = {
        id: `deep-cuts-${today}`,
        type: "deep-cuts",
        name: "Deep Cuts",
        description: "Hidden gems waiting to be discovered",
        colorType: "rediscover",
        seed: getSeededRandom(`deep-cuts-${today}`),
        minTracks: 15,
        limit: WEEKLY_TRACK_LIMIT,
    };
    // Songs nobody has played; when fewer than 15 are, songs played three times or fewer.
    return (
        (await sampledMix({ ...spec, where: Prisma.sql`NOT EXISTS (SELECT 1 FROM "Play" p WHERE p."trackId" = t.id)` })) ??
        sampledMix({
            ...spec,
            where: Prisma.sql`t.id NOT IN (SELECT p."trackId" FROM "Play" p GROUP BY p."trackId" HAVING count(*) > 3)`,
        })
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

    const tracks = await seededTracks({
        where: Prisma.sql`t."analysisStatus" = 'completed' AND t.key IS NOT NULL`,
        include: { album: { select: { coverUrl: true } } },
        take: 200,
        seed: getSeededRandom(`key-journey-${today}`),
    });

    if (tracks.length < 15) return null;

    const byKey = new Map<string, typeof tracks>();
    for (const track of tracks) {
        // Essentia writes C# where keyOrder says Db; group by the table's spelling. The query asks for a key.
        const key = spellingsOf(track.key!).find((s) => keyOrder.includes(s)) ?? track.key!;
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
            const shuffled = seededOrder(keyTracks, keySeed, (t) => t.id);
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
    const seed = getSeededRandom(`tempo-flow-${today}`);
    const tracks = await seededTracks({
        // A tempo the extractor is unsure of would put the song in the wrong band.
        where: Prisma.sql`t."analysisStatus" = 'completed' AND t.bpm IS NOT NULL AND t."bpmConfidence" >= ${STEADY_BEAT}`,
        include: { album: { select: { coverUrl: true } } },
        take: 200,
        seed,
    });

    if (tracks.length < 15) return null;

    // Each band in an order fixed by the day: the flow takes from the front of each, so the same day gives the same
    // songs and every song in a band has the same chance.
    const band = (keep: (bpm: number) => boolean) =>
        seededOrder(tracks.filter((t) => keep(t.bpm!)), seed, (t) => t.id);
    const slow = band((bpm) => bpm < 100);
    const medium = band((bpm) => bpm >= 100 && bpm < 130);
    const fast = band((bpm) => bpm >= 130);

    // 4 + 5 + 6 + 3 + 2: at most WEEKLY_TRACK_LIMIT songs.
    const flow: typeof tracks = [
        ...slow.slice(0, 4),
        ...medium.slice(0, 5),
        ...fast.slice(0, 6),
        ...medium.slice(5, 8),
        ...slow.slice(4, 6),
    ];

    if (flow.length < 15) return null;

    const coverUrls = albumCoverUrls(flow);

    return {
        id: `tempo-flow-${today}`,
        type: "tempo-flow",
        name: "Tempo Flow",
        description: "An energy journey through BPM",
        trackIds: flow.map((t) => t.id),
        coverUrls,
        trackCount: flow.length,
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
        minTracks: 15,
        limit: WEEKLY_TRACK_LIMIT,
        seed: getSeededRandom(`vocal-detox-${today}`),
        // The instrumental cut-off it launched with.
        where: Prisma.sql`t."analysisStatus" = 'completed' AND t.instrumentalness >= 0.75`,
    });
}

export async function generateMinorKeyMix(
    _userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    if (weekdayOf(today) !== 1) return null;

    // Felt energy (arousal) in the upper half of this library, whatever level the library sits at.
    const [{ median }] = await prisma.$queryRaw<Array<{ median: number | null }>>`
        SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY arousal) AS median
        FROM "Track" t
        WHERE t."missingSince" IS NULL AND t."analysisStatus" = 'completed' AND t.arousal IS NOT NULL
          AND EXISTS (SELECT 1 FROM "Album" a WHERE a.id = t."albumId" AND a.location = 'LIBRARY')
    `;
    if (median === null) return null;

    return sampledMix({
        id: `minor-key-${today}`,
        type: "melancholy",
        name: "Minor Key Mondays",
        description: "All minor key bangers",
        colorType: "melancholy",
        minTracks: 15,
        limit: WEEKLY_TRACK_LIMIT,
        seed: getSeededRandom(`minor-key-${today}`),
        where: Prisma.sql`t."analysisStatus" = 'completed' AND t."keyScale" = 'minor' AND t.arousal >= ${median}`,
    });
}
