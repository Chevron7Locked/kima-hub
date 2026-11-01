/**
 * Backend mood keys, in a fixed order (the index is what the star shader sees).
 * Five moods; acoustic/electronic are a sound, not a mood, and are not shown.
 * Each value the backend sends is the track's rank on that mood within this
 * library (0..1), so moods compare fairly with each other.
 */
export const MOOD_KEYS = [
    "moodHappy",
    "moodSad",
    "moodRelaxed",
    "moodAggressive",
    "moodParty",
] as const;

// Warm, muted "matter, not neon" tones so the map reads as a night sky, with
// each mood still distinct from its neighbours.
export const MOOD_COLORS: Record<string, [number, number, number]> = {
    moodHappy:      [240, 178, 90],  // Upbeat — gold
    moodSad:        [185, 143, 224], // Melancholic — lilac
    moodRelaxed:    [91, 194, 180],  // Calm — sea green
    moodAggressive: [224, 104, 94],  // Intense — ember red
    moodParty:      [224, 106, 176], // Energetic — rose
    neutral:        [163, 163, 163], // No single mood
    unanalyzed:     [96, 96, 104],   // Not analysed yet — dimmer grey
};

const MOOD_LABEL_MAP: Record<string, string> = {
    moodHappy: "Upbeat",
    moodSad: "Melancholic",
    moodRelaxed: "Calm",
    moodAggressive: "Intense",
    moodParty: "Energetic",
    neutral: "No single mood",
    unanalyzed: "Not analysed yet",
};

/** Human name for a backend mood key ("moodHappy" → "Upbeat"). */
export function moodLabel(key: string): string {
    return MOOD_LABEL_MAP[key] ?? MOOD_LABEL_MAP.neutral;
}

/** True for one of the five moods; false for "no single mood" / "not analysed yet". */
export function isMood(key: string): boolean {
    return (MOOD_KEYS as readonly string[]).includes(key);
}

/** Index of a mood key in MOOD_KEYS, or -1 for none/neutral. */
export function moodIndex(key: string): number {
    return (MOOD_KEYS as readonly string[]).indexOf(key);
}

/** One stretch of a mood band: a palette key and its share of the analysed tracks (counted by the server). */
export interface MoodShare {
    key: string;
    fraction: number;
}
