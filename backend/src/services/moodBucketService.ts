/**
 * Mood Bucket Service
 *
 * Handles pre-computed mood assignments for fast mood mix generation.
 * Tracks are assigned to mood buckets during audio analysis, enabling
 * instant mood mix generation through simple database lookups.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";

// Mood configuration with scoring rules
// Primary = uses ML mood predictions (enhanced mode)
// Fallback = uses basic audio features (standard mode)
export const MOOD_CONFIG = {
    happy: {
        name: "Happy & Upbeat",
        color: "from-yellow-400 to-orange-500",
        icon: "Smile",
        moodTagKeywords: ["happy", "upbeat", "cheerful", "joyful", "positive"],
        // Primary: ML mood prediction
        primary: { moodHappy: { min: 0.5 }, moodSad: { max: 0.4 } },
        // Fallback: basic audio features
        fallback: { valence: { min: 0.6 }, energy: { min: 0.5 } },
    },
    sad: {
        name: "Melancholic",
        color: "from-blue-600 to-indigo-700",
        icon: "CloudRain",
        moodTagKeywords: ["sad", "melancholic", "melancholy", "dark", "somber"],
        primary: { moodSad: { min: 0.5 }, moodHappy: { max: 0.4 } },
        fallback: { valence: { max: 0.35 }, keyScale: "minor" },
    },
    chill: {
        name: "Chill & Relaxed",
        color: "from-teal-400 to-cyan-500",
        icon: "Wind",
        moodTagKeywords: ["relaxed", "chill", "calm", "mellow"],
        primary: { moodRelaxed: { min: 0.5 }, moodAggressive: { max: 0.3 } },
        fallback: { energy: { max: 0.5 }, arousal: { max: 0.5 } },
    },
    energetic: {
        name: "High Energy",
        color: "from-red-500 to-orange-600",
        icon: "Zap",
        moodTagKeywords: ["energetic", "powerful", "exciting"],
        primary: { arousal: { min: 0.6 }, energy: { min: 0.7 } },
        fallback: { bpm: { min: 120 }, energy: { min: 0.7 } },
    },
    party: {
        name: "Dance Party",
        color: "from-pink-500 to-rose-600",
        icon: "PartyPopper",
        moodTagKeywords: ["party", "danceable", "groovy"],
        primary: { moodParty: { min: 0.5 }, danceability: { min: 0.6 } },
        fallback: { danceability: { min: 0.7 }, energy: { min: 0.6 } },
    },
    focus: {
        name: "Focus Mode",
        color: "from-purple-600 to-violet-700",
        icon: "Brain",
        moodTagKeywords: ["instrumental"],
        primary: { instrumentalness: { min: 0.5 }, moodRelaxed: { min: 0.3 } },
        fallback: {
            instrumentalness: { min: 0.5 },
            energy: { min: 0.2, max: 0.6 },
        },
    },
    melancholy: {
        name: "Deep Feels",
        color: "from-gray-700 to-slate-800",
        icon: "Moon",
        moodTagKeywords: ["sad", "melancholic", "emotional", "dark"],
        primary: { moodSad: { min: 0.4 }, valence: { max: 0.4 } },
        fallback: { valence: { max: 0.35 }, keyScale: "minor" },
    },
    aggressive: {
        name: "Intense",
        color: "from-red-700 to-gray-900",
        icon: "Flame",
        moodTagKeywords: ["aggressive", "angry"],
        primary: { moodAggressive: { min: 0.5 } },
        fallback: { energy: { min: 0.8 }, arousal: { min: 0.7 } },
    },
    acoustic: {
        name: "Acoustic Vibes",
        color: "from-amber-500 to-yellow-600",
        icon: "Guitar",
        moodTagKeywords: ["acoustic"],
        primary: { moodAcoustic: { min: 0.5 }, moodElectronic: { max: 0.4 } },
        fallback: {
            acousticness: { min: 0.6 },
            energy: { min: 0.3, max: 0.6 },
        },
    },
} as const;

export type MoodType = keyof typeof MOOD_CONFIG;
export const VALID_MOODS = Object.keys(MOOD_CONFIG) as MoodType[];

// Mood gradient colors for mix display
const MOOD_GRADIENTS: Record<MoodType, string> = {
    happy: "linear-gradient(to bottom, rgba(217, 119, 6, 0.5), rgba(161, 98, 7, 0.4), rgba(68, 64, 60, 0.4))",
    sad: "linear-gradient(to bottom, rgba(30, 58, 138, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    chill: "linear-gradient(to bottom, rgba(17, 94, 89, 0.6), rgba(22, 78, 99, 0.5), rgba(15, 23, 42, 0.4))",
    energetic:
        "linear-gradient(to bottom, rgba(153, 27, 27, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
    party: "linear-gradient(to bottom, rgba(162, 28, 175, 0.6), rgba(131, 24, 67, 0.5), rgba(59, 7, 100, 0.4))",
    focus: "linear-gradient(to bottom, rgba(91, 33, 182, 0.6), rgba(88, 28, 135, 0.5), rgba(15, 23, 42, 0.4))",
    melancholy:
        "linear-gradient(to bottom, rgba(51, 65, 85, 0.6), rgba(30, 58, 138, 0.5), rgba(17, 24, 39, 0.4))",
    aggressive:
        "linear-gradient(to bottom, rgba(69, 10, 10, 0.7), rgba(17, 24, 39, 0.6), rgba(0, 0, 0, 0.5))",
    acoustic:
        "linear-gradient(to bottom, rgba(146, 64, 14, 0.6), rgba(124, 45, 18, 0.5), rgba(68, 64, 60, 0.4))",
};

interface TrackWithAnalysis {
    id: string;
    analysisMode: string | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
    valence: number | null;
    energy: number | null;
    arousal: number | null;
    danceability: number | null;
    acousticness: number | null;
    instrumentalness: number | null;
    bpm: number | null;
    keyScale: string | null;
    moodTags: string[];
}

export class MoodBucketService {
    /**
     * Calculate mood scores for a track and assign to appropriate buckets
     * Called after audio analysis completes
     * Returns array of mood names the track was assigned to
     */
    async assignTrackToMoods(trackId: string): Promise<string[]> {
        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                id: true,
                analysisStatus: true,
                analysisMode: true,
                moodHappy: true,
                moodSad: true,
                moodRelaxed: true,
                moodAggressive: true,
                moodParty: true,
                moodAcoustic: true,
                moodElectronic: true,
                valence: true,
                energy: true,
                arousal: true,
                danceability: true,
                acousticness: true,
                instrumentalness: true,
                bpm: true,
                keyScale: true,
                moodTags: true,
            },
        });

        if (!track || track.analysisStatus !== "completed") {
            logger.debug(
                `[MoodBucket] Track ${trackId} not analyzed yet, skipping`
            );
            return [];
        }

        const moodScores = this.calculateMoodScores(track);

        // Upsert mood bucket entries for each mood with score > 0
        const upsertPromises = Object.entries(moodScores)
            .filter(([_, score]) => score > 0)
            .map(([mood, score]) =>
                prisma.moodBucket.upsert({
                    where: {
                        trackId_mood: { trackId, mood },
                    },
                    create: {
                        trackId,
                        mood,
                        score,
                    },
                    update: {
                        score,
                    },
                })
            );

        // Also delete mood buckets where score dropped to 0
        const deletePromises = Object.entries(moodScores)
            .filter(([_, score]) => score === 0)
            .map(([mood]) =>
                prisma.moodBucket.deleteMany({
                    where: { trackId, mood },
                })
            );

        await Promise.all([...upsertPromises, ...deletePromises]);

        const assignedMoods = Object.entries(moodScores)
            .filter(([_, score]) => score > 0)
            .map(([mood]) => mood);

        logger.debug(
            `[MoodBucket] Track ${trackId} assigned to moods: ${
                assignedMoods.join(", ") || "none"
            }`
        );

        return assignedMoods;
    }

    /**
     * Calculate mood scores for a track based on its audio features
     * Returns a score 0-1 for each mood (0 = not matching, 1 = perfect match)
     */
    calculateMoodScores(track: TrackWithAnalysis): Record<MoodType, number> {
        const isEnhanced = track.analysisMode === "enhanced";
        const scores: Record<MoodType, number> = {
            happy: 0,
            sad: 0,
            chill: 0,
            energetic: 0,
            party: 0,
            focus: 0,
            melancholy: 0,
            aggressive: 0,
            acoustic: 0,
        };

        // Check if we have individual mood fields OR moodTags
        const hasIndividualMoods = track.moodHappy !== null || track.moodSad !== null;
        const hasMoodTags = track.moodTags && track.moodTags.length > 0;

        // If we have moodTags but no individual mood fields, parse moodTags
        if (!hasIndividualMoods && hasMoodTags) {
            return this.calculateMoodScoresFromTags(track.moodTags);
        }

        // Otherwise use original logic
        for (const [mood, config] of Object.entries(MOOD_CONFIG)) {
            const rules = isEnhanced ? config.primary : config.fallback;
            const score = this.evaluateMoodRules(track, rules);
            scores[mood as MoodType] = score;
        }

        return scores;
    }

    /**
     * Calculate mood scores from moodTags array
     * Used when individual mood fields are not populated
     */
    private calculateMoodScoresFromTags(moodTags: string[]): Record<MoodType, number> {
        const scores: Record<MoodType, number> = {
            happy: 0,
            sad: 0,
            chill: 0,
            energetic: 0,
            party: 0,
            focus: 0,
            melancholy: 0,
            aggressive: 0,
            acoustic: 0,
        };

        const normalizedTags = moodTags.map(tag => tag.toLowerCase());

        for (const [mood, config] of Object.entries(MOOD_CONFIG)) {
            const keywords = config.moodTagKeywords;
            let matchCount = 0;

            for (const keyword of keywords) {
                if (normalizedTags.includes(keyword)) {
                    matchCount++;
                }
            }

            if (matchCount > 0) {
                scores[mood as MoodType] = Math.min(1.0, 0.3 + (matchCount - 1) * 0.2);
            }
        }

        return scores;
    }

    /**
     * Evaluate mood rules against track features
     * Returns a score 0-1 based on how well the track matches the rules
     */
    private evaluateMoodRules(
        track: TrackWithAnalysis,
        rules: Record<string, any>
    ): number {
        let totalScore = 0;
        let ruleCount = 0;

        for (const [field, constraints] of Object.entries(rules)) {
            const value = track[field as keyof TrackWithAnalysis];

            // Skip if value is null
            if (value === null || value === undefined) {
                continue;
            }

            ruleCount++;

            // Handle string equality (e.g., keyScale: "minor")
            if (typeof constraints === "string") {
                totalScore += value === constraints ? 1 : 0;
                continue;
            }

            // Handle numeric range constraints
            const numValue = value as number;
            const { min, max } = constraints as { min?: number; max?: number };

            // Calculate how well the value matches the constraint
            let fieldScore = 0;

            if (min !== undefined && max !== undefined) {
                // Range constraint - value should be between min and max
                if (numValue >= min && numValue <= max) {
                    // Perfect match in range
                    fieldScore = 1;
                } else if (numValue < min) {
                    // Below range - linearly decrease score
                    fieldScore = Math.max(0, 1 - (min - numValue) * 2);
                } else {
                    // Above range - linearly decrease score
                    fieldScore = Math.max(0, 1 - (numValue - max) * 2);
                }
            } else if (min !== undefined) {
                // Minimum constraint - higher is better
                if (numValue >= min) {
                    // Score increases with value above threshold
                    fieldScore = Math.min(1, 0.5 + (numValue - min) * 0.5);
                } else {
                    // Below minimum - partial credit
                    fieldScore = Math.max(0, (numValue / min) * 0.5);
                }
            } else if (max !== undefined) {
                // Maximum constraint - lower is better
                if (numValue <= max) {
                    // Score increases as value decreases below threshold
                    fieldScore = Math.min(1, 0.5 + (max - numValue) * 0.5);
                } else {
                    // Above maximum - partial credit
                    fieldScore = Math.max(
                        0,
                        ((1 - numValue) / (1 - max)) * 0.5
                    );
                }
            }

            totalScore += fieldScore;
        }

        // No rules matched (missing data)
        if (ruleCount === 0) return 0;

        // Average score across all rules, with minimum threshold
        const avgScore = totalScore / ruleCount;

        // Only assign to mood if score is above 0.5 threshold
        return avgScore >= 0.5 ? avgScore : 0;
    }

    /**
     * Get mood presets with track counts for the UI
     */
    async getMoodPresets(): Promise<
        {
            id: string;
            name: string;
            color: string;
            icon: string;
            trackCount: number;
        }[]
    > {
        // Count tracks per mood in parallel
        const countPromises = VALID_MOODS.map(async (mood) => {
            const count = await prisma.moodBucket.count({
                where: { mood, score: { gte: 0.5 } },
            });
            const config = MOOD_CONFIG[mood];
            return {
                id: mood,
                name: config.name,
                color: config.color,
                icon: config.icon,
                trackCount: count,
            };
        });

        return Promise.all(countPromises);
    }

    /**
     * Get a mood mix for a specific mood
     * Fast lookup from pre-computed MoodBucket table
     */
    async getMoodMix(
        mood: MoodType,
        limit: number = 15
    ): Promise<{
        id: string;
        mood: string;
        name: string;
        description: string;
        trackIds: string[];
        coverUrls: string[];
        trackCount: number;
        color: string;
    } | null> {
        if (!VALID_MOODS.includes(mood)) {
            throw new Error(`Invalid mood: ${mood}`);
        }

        const config = MOOD_CONFIG[mood];

        // Get top tracks for this mood, randomly sampled
        // First get IDs with high scores, then randomly select
        const moodBuckets = await prisma.moodBucket.findMany({
            where: { mood, score: { gte: 0.5 } },
            select: { trackId: true, score: true },
            orderBy: { score: "desc" },
            take: 100, // Pool to sample from
        });

        if (moodBuckets.length < 8) {
            logger.debug(
                `[MoodBucket] Not enough tracks for mood ${mood}: ${moodBuckets.length}`
            );
            return null;
        }

        // Randomly sample from the pool
        const shuffled = [...moodBuckets].sort(() => Math.random() - 0.5);
        const selectedIds = shuffled.slice(0, limit).map((b) => b.trackId);

        // Get cover URLs for the selected tracks
        const tracks = await prisma.track.findMany({
            where: { id: { in: selectedIds } },
            select: {
                id: true,
                album: { select: { coverUrl: true } },
            },
        });

        // Preserve order of selectedIds
        const orderedTracks = selectedIds
            .map((id) => tracks.find((t) => t.id === id))
            .filter(Boolean);
        const coverUrls = orderedTracks
            .filter((t) => t?.album.coverUrl)
            .slice(0, 4)
            .map((t) => t!.album.coverUrl!);

        const timestamp = Date.now();
        return {
            id: `mood-${mood}-${timestamp}`,
            mood,
            name: `${config.name} Mix`,
            description: `Tracks that match your ${config.name.toLowerCase()} vibe`,
            trackIds: orderedTracks.map((t) => t!.id),
            coverUrls,
            trackCount: orderedTracks.length,
            color: MOOD_GRADIENTS[mood],
        };
    }

    /**
     * Save a mood mix as the user's active mood mix
     * Returns the saved mix for immediate UI update
     */
    async saveUserMoodMix(
        userId: string,
        mood: MoodType,
        limit: number = 15
    ): Promise<{
        id: string;
        mood: string;
        name: string;
        description: string;
        trackIds: string[];
        coverUrls: string[];
        trackCount: number;
        color: string;
        generatedAt: string;
    } | null> {
        // Generate a fresh mix
        const mix = await this.getMoodMix(mood, limit);
        if (!mix) return null;

        const config = MOOD_CONFIG[mood];
        const generatedAt = new Date();

        // Upsert the user's mood mix
        await prisma.userMoodMix.upsert({
            where: { userId },
            create: {
                userId,
                mood,
                trackIds: mix.trackIds,
                coverUrls: mix.coverUrls,
                generatedAt,
            },
            update: {
                mood,
                trackIds: mix.trackIds,
                coverUrls: mix.coverUrls,
                generatedAt,
            },
        });

        logger.debug(
            `[MoodBucket] Saved ${mood} mix for user ${userId} (${mix.trackCount} tracks)`
        );

        // Return with user-specific naming
        return {
            id: `your-mood-mix-${generatedAt.getTime()}`,
            mood,
            name: `Your ${config.name} Mix`,
            description: `Based on your ${config.name.toLowerCase()} preferences`,
            trackIds: mix.trackIds,
            coverUrls: mix.coverUrls,
            trackCount: mix.trackCount,
            color: MOOD_GRADIENTS[mood],
            generatedAt: generatedAt.toISOString(),
        };
    }

    /**
     * Get user's current saved mood mix for display on home page
     */
    async getUserMoodMix(userId: string): Promise<{
        id: string;
        type: string;
        mood: string;
        name: string;
        description: string;
        trackIds: string[];
        coverUrls: string[];
        trackCount: number;
        color: string;
    } | null> {
        const userMix = await prisma.userMoodMix.findUnique({
            where: { userId },
        });

        if (!userMix) return null;

        const mood = userMix.mood as MoodType;
        if (!VALID_MOODS.includes(mood)) return null;

        const config = MOOD_CONFIG[mood];

        return {
            id: `your-mood-mix-${userMix.generatedAt.getTime()}`,
            type: "mood",
            mood,
            name: `Your ${config.name} Mix`,
            description: `Based on your ${config.name.toLowerCase()} preferences`,
            trackIds: userMix.trackIds,
            coverUrls: userMix.coverUrls,
            trackCount: userMix.trackIds.length,
            color: MOOD_GRADIENTS[mood],
        };
    }

    /**
     * Backfill mood buckets for all analyzed tracks
     * Used for initial population or after schema changes
     */
    async backfillAllTracks(
        batchSize: number = 100
    ): Promise<{ processed: number; assigned: number }> {
        let processed = 0;
        let assigned = 0;
        let skip = 0;

        logger.debug("[MoodBucket] Starting backfill of all analyzed tracks...");

        while (true) {
            const tracks = await prisma.track.findMany({
                where: { analysisStatus: "completed" },
                select: {
                    id: true,
                    analysisMode: true,
                    moodHappy: true,
                    moodSad: true,
                    moodRelaxed: true,
                    moodAggressive: true,
                    moodParty: true,
                    moodAcoustic: true,
                    moodElectronic: true,
                    valence: true,
                    energy: true,
                    arousal: true,
                    danceability: true,
                    acousticness: true,
                    instrumentalness: true,
                    bpm: true,
                    keyScale: true,
                    moodTags: true,
                },
                skip,
                take: batchSize,
            });

            if (tracks.length === 0) break;

            for (const track of tracks) {
                const moodScores = this.calculateMoodScores(track);
                const moodsToAssign = Object.entries(moodScores)
                    .filter(([_, score]) => score > 0)
                    .map(([mood, score]) => ({
                        trackId: track.id,
                        mood,
                        score,
                    }));

                if (moodsToAssign.length > 0) {
                    // Use upsert for each mood
                    await Promise.all(
                        moodsToAssign.map((data) =>
                            prisma.moodBucket.upsert({
                                where: {
                                    trackId_mood: {
                                        trackId: data.trackId,
                                        mood: data.mood,
                                    },
                                },
                                create: {
                                    trackId: data.trackId,
                                    mood: data.mood,
                                    score: data.score,
                                },
                                update: {
                                    score: data.score,
                                },
                            })
                        )
                    );
                    assigned += moodsToAssign.length;
                }

                processed++;
            }

            skip += batchSize;
            logger.debug(
                `[MoodBucket] Backfill progress: ${processed} tracks processed, ${assigned} mood assignments`
            );
        }

        logger.debug(
            `[MoodBucket] Backfill complete: ${processed} tracks processed, ${assigned} mood assignments`
        );
        return { processed, assigned };
    }

    /**
     * Clear all mood bucket data for a track
     * Used when a track is re-analyzed
     */
    async clearTrackMoods(trackId: string): Promise<void> {
        await prisma.moodBucket.deleteMany({
            where: { trackId },
        });
    }
}

export const moodBucketService = new MoodBucketService();
