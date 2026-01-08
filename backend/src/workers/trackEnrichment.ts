import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { lastFmService } from "../services/lastfm";

// Configuration
const TRACK_ENRICHMENT_BATCH_SIZE = 20;
const TRACK_ENRICHMENT_INTERVAL_MS = 60 * 1000; // Run every 60 seconds

let isEnrichingTracks = false;
let trackEnrichmentInterval: NodeJS.Timeout | null = null;

// Mood-related tags to look for (lowercase for matching)
const MOOD_TAGS = new Set([
    // Energy/Activity
    "chill", "relax", "relaxing", "calm", "peaceful", "ambient",
    "energetic", "upbeat", "hype", "party", "dance",
    "workout", "gym", "running", "exercise", "motivation",
    
    // Emotions
    "sad", "melancholy", "melancholic", "depressing", "heartbreak",
    "happy", "feel good", "feel-good", "joyful", "uplifting",
    "angry", "aggressive", "intense",
    "romantic", "love", "sensual",
    
    // Time/Setting
    "night", "late night", "evening", "morning",
    "summer", "winter", "rainy", "sunny",
    "driving", "road trip", "travel",
    
    // Activity
    "study", "focus", "concentration", "work",
    "sleep", "sleeping", "bedtime",
    "cooking", "dinner",
    
    // Vibe
    "dreamy", "atmospheric", "ethereal", "spacey",
    "groovy", "funky", "smooth",
    "dark", "moody", "brooding",
    "epic", "cinematic", "dramatic",
    "nostalgic", "throwback",
]);

/**
 * Filter tags to only include mood-relevant ones
 */
function filterMoodTags(tags: string[]): string[] {
    return tags
        .map(t => t.toLowerCase().trim())
        .filter(t => {
            // Check exact match
            if (MOOD_TAGS.has(t)) return true;
            // Check if any mood tag is contained in this tag
            for (const mood of MOOD_TAGS) {
                if (t.includes(mood) || mood.includes(t)) return true;
            }
            return false;
        })
        .slice(0, 10); // Limit to 10 tags per track
}

/**
 * Start the track enrichment worker
 */
export async function startTrackEnrichmentWorker() {
    logger.debug("[Track Enrichment] Starting worker...");
    logger.debug(`   - Batch size: ${TRACK_ENRICHMENT_BATCH_SIZE}`);
    logger.debug(`   - Interval: ${TRACK_ENRICHMENT_INTERVAL_MS / 1000}s`);

    // Run immediately
    await enrichNextTrackBatch();

    // Then run at interval
    trackEnrichmentInterval = setInterval(async () => {
        await enrichNextTrackBatch();
    }, TRACK_ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the track enrichment worker
 */
export function stopTrackEnrichmentWorker() {
    if (trackEnrichmentInterval) {
        clearInterval(trackEnrichmentInterval);
        trackEnrichmentInterval = null;
        logger.debug("[Track Enrichment] Worker stopped");
    }
}

/**
 * Process next batch of tracks for Last.fm tag enrichment
 */
async function enrichNextTrackBatch() {
    if (isEnrichingTracks) return;

    try {
        isEnrichingTracks = true;

        // Find tracks that don't have lastfmTags yet
        // Prioritize tracks from artists that are already enriched
        const tracks = await prisma.track.findMany({
            where: {
                lastfmTags: {
                    isEmpty: true,
                },
                album: {
                    artist: {
                        enrichmentStatus: "completed",
                    },
                },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                name: true,
                            },
                        },
                    },
                },
            },
            take: TRACK_ENRICHMENT_BATCH_SIZE,
            orderBy: {
                // Prioritize recently modified (newly added) tracks
                fileModified: "desc",
            },
        });

        if (tracks.length === 0) {
            return;
        }

        logger.debug(`[Track Enrichment] Processing ${tracks.length} tracks...`);

        // Process tracks with rate limiting (Last.fm has rate limits)
        for (const track of tracks) {
            try {
                const artistName = track.album.artist.name;
                
                // Fetch track info from Last.fm
                const trackInfo = await lastFmService.getTrackInfo(artistName, track.title);
                
                if (trackInfo?.toptags?.tag) {
                    const allTags = trackInfo.toptags.tag.map((t: any) => t.name);
                    const moodTags = filterMoodTags(allTags);
                    
                    if (moodTags.length > 0) {
                        await prisma.track.update({
                            where: { id: track.id },
                            data: { lastfmTags: moodTags },
                        });
                        logger.debug(` ${artistName} - ${track.title}: [${moodTags.join(", ")}]`);
                    } else {
                        // Mark as processed even if no mood tags found (use empty array marker)
                        await prisma.track.update({
                            where: { id: track.id },
                            data: { lastfmTags: ["_no_mood_tags"] },
                        });
                        logger.debug(`   - ${artistName} - ${track.title}: no mood tags`);
                    }
                } else {
                    // No tags from Last.fm
                    await prisma.track.update({
                        where: { id: track.id },
                        data: { lastfmTags: ["_not_found"] },
                    });
                }

                // Small delay between requests to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (error: any) {
                logger.error(` ${track.title}: ${error?.message || error}`);
            }
        }

        // Log progress
        const progress = await getTrackEnrichmentProgress();
        logger.debug(`[Track Enrichment] ${progress.enriched}/${progress.total} tracks enriched`);
    } catch (error) {
        logger.error("[Track Enrichment] Batch error:", error);
    } finally {
        isEnrichingTracks = false;
    }
}

/**
 * Get track enrichment progress
 */
export async function getTrackEnrichmentProgress() {
    const total = await prisma.track.count();
    const enriched = await prisma.track.count({
        where: {
            lastfmTags: {
                isEmpty: false,
            },
        },
    });
    const withMoodTags = await prisma.track.count({
        where: {
            lastfmTags: {
                hasSome: MOOD_TAGS.size > 0 ? Array.from(MOOD_TAGS).slice(0, 10) : [],
            },
        },
    });

    return {
        total,
        enriched,
        withMoodTags,
        pending: total - enriched,
        progress: total > 0 ? Math.round((enriched / total) * 100) : 0,
    };
}

/**
 * Manually trigger enrichment for specific tracks
 */
export async function enrichTracksForAlbum(albumId: string) {
    const tracks = await prisma.track.findMany({
        where: { albumId },
        include: {
            album: {
                include: {
                    artist: {
                        select: { name: true },
                    },
                },
            },
        },
    });

    logger.debug(`[Track Enrichment] Enriching ${tracks.length} tracks for album ${albumId}`);

    for (const track of tracks) {
        try {
            const trackInfo = await lastFmService.getTrackInfo(
                track.album.artist.name,
                track.title
            );
            
            if (trackInfo?.toptags?.tag) {
                const allTags = trackInfo.toptags.tag.map((t: any) => t.name);
                const moodTags = filterMoodTags(allTags);
                
                await prisma.track.update({
                    where: { id: track.id },
                    data: { lastfmTags: moodTags.length > 0 ? moodTags : ["_no_mood_tags"] },
                });
            }
            
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
            logger.error(`Failed to enrich track ${track.title}:`, error);
        }
    }
}





