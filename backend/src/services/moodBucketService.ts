/**
 * A track's moods from five learned moods: happy (Upbeat), sad (Melancholic), calm (Calm), aggressive (Intense), party
 * (Energetic). A track has a mood at RECIPE_LINE SD above the library's mean (as the mixes do); its library rank picks
 * the dominant label. The snapshot rebuilds when the statistics change. Each mood page's mix draws from its page recipe.
 */

import { Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { albumCoverUrls, getMixColor, tracksByIds } from "./mixes/helpers";
import { RECIPE_LINE, UnrankableLibraryError, getRecipe, pageMemberCount, pickPageTracks } from "./mixes/recipes";
import { MOOD_HEADS, type Mood } from "./moods/heads";
import { SCORED_SONGS_RULE } from "./moods/scoredSongs";
import { MOOD_STATE_VERSION, loadMoodState, type MoodStats } from "./moods/state";

/**
 * `id` is the mood's id and `field` the name the vibe map and the apps key the mood on: both kept from the old
 * Essentia heads so no client breaks. `learned` is the learned mood behind it, `recipe` the mood page's recipe.
 */
export const MOODS = [
    { id: "happy", field: "moodHappy", learned: "happy", recipe: "upbeat", name: "Upbeat", color: "from-yellow-400 to-orange-500", icon: "Smile" },
    { id: "sad", field: "moodSad", learned: "sad", recipe: "melancholy", name: "Melancholic", color: "from-blue-600 to-indigo-700", icon: "CloudRain" },
    { id: "chill", field: "moodRelaxed", learned: "calm", recipe: "calm", name: "Calm", color: "from-teal-400 to-cyan-500", icon: "Wind" },
    { id: "aggressive", field: "moodAggressive", learned: "aggressive", recipe: "intense", name: "Intense", color: "from-red-700 to-gray-900", icon: "Flame" },
    { id: "party", field: "moodParty", learned: "party", recipe: "energetic", name: "Energetic", color: "from-pink-500 to-rose-600", icon: "PartyPopper" },
] as const satisfies readonly (Record<string, string> & { learned: Mood })[];

export type MoodType = (typeof MOODS)[number]["id"];
export type MoodField = (typeof MOODS)[number]["field"];
export const VALID_MOODS: MoodType[] = MOODS.map((m) => m.id);
const MOOD_FIELDS: MoodField[] = MOODS.map((m) => m.field);

/** Analysed, but no mood stands out for this track. */
export const NEUTRAL = "neutral";
/** No current mood scores for this track (analysis, its sound vector or the mood step pending, or failed). */
export const UNANALYZED = "unanalyzed";

const MOOD_BY_ID: Record<MoodType, (typeof MOODS)[number]> = Object.fromEntries(
    MOODS.map((m) => [m.id, m])
) as Record<MoodType, (typeof MOODS)[number]>;

/** A track's learned mood scores (logits), under the client-facing names. */
export type MoodValues = { [F in MoodField]: number | null };

export interface MoodView {
    /** A MoodField, NEUTRAL, or UNANALYZED. */
    dominant: string;
    /** Library rank (0..1) of the dominant mood; 0 for NEUTRAL / UNANALYZED. */
    score: number;
    /** Library rank (0..1) per mood; empty when UNANALYZED. */
    ranks: Partial<Record<MoodField, number>>;
    /** Every mood the track has: its score at least RECIPE_LINE standard deviations above the library's mean. */
    moods: MoodField[];
}

function lowerBound(sorted: Float64Array, v: number): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < v) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function upperBound(sorted: Float64Array, v: number): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] <= v) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** Each mood's sorted library values, for ranking a value within the library, and the library's mood statistics. */
export class MoodDistribution {
    private readonly sorted: Record<MoodField, Float64Array>;
    readonly size: number;

    constructor(rows: MoodValues[], private readonly stats: Record<MoodField, MoodStats>) {
        const complete = rows.filter(isAnalysed);
        this.size = complete.length;
        this.sorted = Object.fromEntries(
            MOOD_FIELDS.map((f) => [
                f,
                Float64Array.from(complete.map((r) => r[f] as number)).sort(),
            ])
        ) as Record<MoodField, Float64Array>;
    }

    /** Share of the library below v on this mood, counting ties as half. */
    rank(field: MoodField, v: number): number {
        const s = this.sorted[field];
        if (s.length === 0) return 0;
        return (lowerBound(s, v) + upperBound(s, v)) / 2 / s.length;
    }

    /**
     * How many of the library's standard deviations v sits above its mean on this mood. A mood with no spread in the
     * library ranks no one above anyone: -Infinity, under any line, as the recipe engine and the song tags treat it.
     */
    z(field: MoodField, v: number): number {
        const { mean, sd } = this.stats[field];
        if (!(sd > 0)) return -Infinity;
        return (v - mean) / sd;
    }
}

function isAnalysed(row: MoodValues): boolean {
    return MOOD_FIELDS.every((f) => row[f] !== null && row[f] !== undefined);
}

/** Decide a track's moods against its library. Pure. */
export function classifyMoods(row: MoodValues, dist: MoodDistribution): MoodView {
    if (!isAnalysed(row) || dist.size === 0) {
        return { dominant: UNANALYZED, score: 0, ranks: {}, moods: [] };
    }
    const ranks: Partial<Record<MoodField, number>> = {};
    const moods: MoodField[] = [];
    let dominant: string = NEUTRAL;
    let score = 0;
    for (const f of MOOD_FIELDS) {
        const value = row[f] as number;
        const r = dist.rank(f, value);
        ranks[f] = r;
        if (dist.z(f, value) >= RECIPE_LINE) {
            moods.push(f);
            if (r > score) {
                dominant = f;
                score = r;
            }
        }
    }
    return { dominant, score, ranks, moods };
}

/**
 * The signature while the library has no current mood statistics (a rescore or a weights change before the next
 * mood pass finishes): nothing is judged then, and the last snapshot stands.
 */
export const NO_STATISTICS = "none";

export interface MoodSnapshot {
    /**
     * The mood statistics' version and inputs fingerprint: changes whenever a track's mood scores could. NO_STATISTICS
     * only for a snapshot built before this process ever saw statistics; it has no views.
     */
    signature: string;
    views: Map<string, MoodView>;
    /** Tracks still waiting for mood scores. */
    pending: number;
}

let snapshot: MoodSnapshot | null = null;
let building: Promise<MoodSnapshot> | null = null;

/**
 * The statistics' version and fingerprint, which change with any rescore, sound vector, reading or eligible track;
 * and how many present tracks are still waiting for mood scores: analysis running, or a sound vector the mood step
 * has not scored with the current weights. A vector the step can never score (the wrong length, or zero) is not
 * waiting, by the same rule as the step's progress (moodProgress).
 */
async function librarySignature(): Promise<{ signature: string; pending: number }> {
    const state = await prisma.moodState.findUnique({
        where: { id: "default" },
        select: { version: true, fingerprint: true },
    });
    const [{ pending }] = await prisma.$queryRaw<Array<{ pending: number }>>`
        SELECT count(*)::int AS pending
        FROM "Track" t
        LEFT JOIN track_embeddings te ON te.track_id = t.id AND te.model_version = ${MOOD_HEADS.model}
                                     AND vector_dims(te.embedding) = ${MOOD_HEADS.dims} AND vector_norm(te.embedding) > 0
        LEFT JOIN track_moods m ON m.track_id = t.id
        WHERE t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')
          AND (t."analysisStatus" IN ('pending', 'queued', 'processing')
               OR (te.track_id IS NOT NULL AND (m.embedded_at IS DISTINCT FROM te.analyzed_at
                                                OR m.weights IS DISTINCT FROM ${MOOD_HEADS.version})))
    `;
    return {
        signature: state?.version === MOOD_STATE_VERSION ? `${state.version}:${state.fingerprint}` : NO_STATISTICS,
        pending,
    };
}

/** Every track the mood statistics cover (current scores, a present readable file, finished analysis), classified. */
async function buildSnapshot(signature: string, pending: number): Promise<MoodSnapshot> {
    const state = await loadMoodState();
    if (!state) return { signature: NO_STATISTICS, views: new Map(), pending };
    const scores = Prisma.raw(MOODS.map((m) => `m."${m.learned}"::float8 AS "${m.field}"`).join(", "));
    const rows = await prisma.$queryRaw<Array<{ id: string } & MoodValues>>`
        SELECT t.id, ${scores}
        FROM track_moods m
        JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
        JOIN "Track" t ON t.id = m.track_id
        WHERE ${SCORED_SONGS_RULE}
    `;
    const stats = Object.fromEntries(MOODS.map((m) => [m.field, state.moods[m.learned]])) as Record<MoodField, MoodStats>;
    const dist = new MoodDistribution(rows, stats);
    const views = new Map<string, MoodView>();
    for (const row of rows) {
        views.set(row.id, classifyMoods(row, dist));
    }
    return { signature, views, pending };
}

/**
 * The current library's mood decisions. Re-reads the library only when its signature changed; `changed` says whether
 * this call rebuilt it. While the library has no current statistics the last snapshot stands, unchanged.
 */
export async function refreshMoodSnapshot(): Promise<{ snapshot: MoodSnapshot; changed: boolean }> {
    const { signature, pending } = await librarySignature();
    if (snapshot && (snapshot.signature === signature || signature === NO_STATISTICS)) {
        snapshot.pending = pending;
        return { snapshot, changed: false };
    }
    if (!building) {
        building = buildSnapshot(signature, pending).finally(() => {
            building = null;
        });
    }
    const built = await building;
    // The statistics went away while this one was being built.
    if (snapshot && built.signature === NO_STATISTICS) {
        snapshot.pending = pending;
        return { snapshot, changed: false };
    }
    snapshot = built;
    return { snapshot, changed: true };
}

/**
 * The last built snapshot (the mood snapshot worker refreshes it every cycle),
 * or a fresh one if none exists yet. For read paths that must not query the
 * library on every request.
 */
export async function currentMoodSnapshot(): Promise<MoodSnapshot> {
    if (snapshot) return snapshot;
    return (await refreshMoodSnapshot()).snapshot;
}

/** Map a track's view to the fields the vibe map serves. */
export function moodOutput(view: MoodView | undefined): {
    dominantMood: string;
    moodScore: number;
    moods: Record<string, number>;
} {
    if (!view) return { dominantMood: UNANALYZED, moodScore: 0, moods: {} };
    return { dominantMood: view.dominant, moodScore: view.score, moods: view.ranks as Record<string, number> };
}

/**
 * How many songs a mood page draws from: its recipe's members at the line, counted in the database; none when the page
 * would have no mix (fewer than its minimum) or the library cannot rank the recipe.
 */
async function pageSongCount(recipe: string): Promise<number> {
    try {
        return await pageMemberCount(getRecipe(recipe));
    } catch (error) {
        if (error instanceof UnrankableLibraryError) return 0;
        throw error;
    }
}

/** A mood's mix as served. A saved mix read back also carries `type`; one just saved, `generatedAt`. */
interface MoodMix {
    id: string;
    mood: string;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
}

/** The mood pages' mixes, and each listener's saved one. */
class MoodBucketService {
    /**
     * Get mood presets with track counts for the UI. A preset's count is how many songs its mood page draws from: the
     * page recipe's members at the line (none when the library cannot rank it), not every track with the mood. `pendingTracks`
     * is how many library tracks are still waiting for mood analysis, so the UI can say "not analysed yet" instead of
     * showing an empty mood as final.
     */
    async getMoodPresets(): Promise<
        {
            id: string;
            name: string;
            color: string;
            icon: string;
            trackCount: number;
            pendingTracks: number;
        }[]
    > {
        const [counts, snap] = await Promise.all([
            Promise.all(MOODS.map((m) => pageSongCount(m.recipe))),
            currentMoodSnapshot(),
        ]);
        return MOODS.map((m, i) => ({
            id: m.id,
            name: m.name,
            color: m.color,
            icon: m.icon,
            trackCount: counts[i],
            pendingTracks: snap.pending,
        }));
    }

    async getMoodMix(
        mood: MoodType,
        limit: number = 15,
        excludeTrackIds: string[] = []
    ): Promise<MoodMix | null> {
        if (!VALID_MOODS.includes(mood)) {
            throw new Error(`Invalid mood: ${mood}`);
        }

        const config = MOOD_BY_ID[mood];

        // The mood page's recipe, skipping what this user was already served unless that leaves too few to mix from.
        // A library the recipe cannot rank has no mix, like one with too few members.
        const drawn = await pickPageTracks(getRecipe(config.recipe), { limit, exclude: excludeTrackIds }).catch(
            (error: unknown) => {
                if (error instanceof UnrankableLibraryError) return null;
                throw error;
            }
        );
        if (!drawn) {
            logger.debug(`[MoodBucket] Not enough tracks for the ${mood} mood page`);
            return null;
        }
        const orderedTracks = await tracksByIds(drawn, { album: { select: { coverUrl: true } } });
        const coverUrls = albumCoverUrls(orderedTracks);

        const timestamp = Date.now();
        return {
            id: `mood-${mood}-${timestamp}`,
            mood,
            name: `${config.name} Mix`,
            description: `Tracks that match your ${config.name.toLowerCase()} vibe`,
            trackIds: orderedTracks.map((t) => t.id),
            coverUrls,
            trackCount: orderedTracks.length,
            color: getMixColor(mood),
        };
    }

    /**
     * Save the user's active mood mix: the given trackIds that are playable library songs (order kept,
     * unknown, missing, corrupt and Discover ids dropped), or a fresh mix when none are given. Returns the mix, or null
     * (the listener's previous mix is left as it was) when there is nothing to save: no song sent is playable, or the
     * library has too few for a fresh mix.
     */
    async saveUserMoodMix(
        userId: string,
        mood: MoodType,
        limit: number = 15,
        trackIds?: string[]
    ): Promise<(MoodMix & { generatedAt: string }) | null> {
        const config = MOOD_BY_ID[mood];
        const generatedAt = new Date();

        // The listener's own picks that exist, in their order; otherwise a fresh mix that skips what they were served.
        let mixTrackIds: string[];
        let coverUrls: string[];
        if (trackIds && trackIds.length > 0) {
            const tracks = await tracksByIds(trackIds, { album: { select: { coverUrl: true } } });
            if (tracks.length === 0) return null;
            mixTrackIds = tracks.map((t) => t.id);
            coverUrls = albumCoverUrls(tracks);
        } else {
            const mix = await this.getMoodMix(mood, limit, await this.getRememberedTrackIds(userId, mood));
            if (!mix) return null;
            mixTrackIds = mix.trackIds;
            coverUrls = mix.coverUrls;
        }

        const saved = { mood, trackIds: mixTrackIds, coverUrls, servedTrackIds: mixTrackIds, generatedAt };
        await prisma.userMoodMix.upsert({ where: { userId }, create: { userId, ...saved }, update: saved });
        logger.debug(`[MoodBucket] Saved ${mood} mix for user ${userId} (${mixTrackIds.length} tracks)`);

        return {
            id: `your-mood-mix-${generatedAt.getTime()}`,
            mood,
            name: `Your ${config.name} Mix`,
            description: `Based on your ${config.name.toLowerCase()} preferences`,
            trackIds: mixTrackIds,
            coverUrls,
            trackCount: mixTrackIds.length,
            color: getMixColor(mood),
            generatedAt: generatedAt.toISOString(),
        };
    }

    /**
     * The listener's saved mood mix, for the home page. Its songs are read again: one deleted, corrupt, missing or moved
     * to Discover since the mix was saved is not counted, and the covers are those of the songs left. Null when none is.
     */
    async getUserMoodMix(userId: string): Promise<(MoodMix & { type: string }) | null> {
        const userMix = await prisma.userMoodMix.findUnique({
            where: { userId },
        });

        if (!userMix) return null;

        const mood = userMix.mood as MoodType;
        if (!VALID_MOODS.includes(mood)) return null;

        const config = MOOD_BY_ID[mood];
        const tracks = await tracksByIds(userMix.trackIds, { album: { select: { coverUrl: true } } });
        if (tracks.length === 0) return null;

        return {
            id: `your-mood-mix-${userMix.generatedAt.getTime()}`,
            type: "mood",
            mood,
            name: `Your ${config.name} Mix`,
            description: `Based on your ${config.name.toLowerCase()} preferences`,
            trackIds: tracks.map((t) => t.id),
            coverUrls: albumCoverUrls(tracks),
            trackCount: tracks.length,
            color: getMixColor(mood),
        };
    }

    /**
     * Forget the user's saved mood mix, so the next one is built from the
     * current mood values. deleteMany, so a repeat is a no-op, not an error.
     */
    async clearUserMoodMix(userId: string): Promise<{ removed: number }> {
        const { count } = await prisma.userMoodMix.deleteMany({ where: { userId } });
        if (count) logger.debug(`[MoodBucket] Cleared saved mood mix for user ${userId}`);
        return { removed: count };
    }

    /**
     * Track ids this user was already given for a mood: what the last serving
     * remembered, plus the saved mix itself. The next getMoodMix for that mood
     * skips them, so regenerating doesn't replay the same tracks.
     */
    async getRememberedTrackIds(
        userId: string,
        mood: MoodType
    ): Promise<string[]> {
        const row = await prisma.userMoodMix.findUnique({
            where: { userId },
        });

        if (!row || row.mood !== mood) return [];

        return Array.from(new Set([...row.servedTrackIds, ...row.trackIds]));
    }

    /**
     * Remember the exact ids a mix was served with, so the next mix for this
     * user skips them. Update-only: without a saved mix there is nothing to
     * remember against, and creating one would surface an empty mix on the
     * home page. Keyed on the mood too, so the memory can't leak across moods.
     */
    async recordServedTracks(
        userId: string,
        mood: MoodType,
        trackIds: string[]
    ): Promise<void> {
        if (trackIds.length === 0) return;

        await prisma.userMoodMix.updateMany({
            where: { userId, mood },
            data: { servedTrackIds: trackIds },
        });
    }
}

export const moodBucketService = new MoodBucketService();
