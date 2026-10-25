/**
 * "More like what this listener already plays", for the recipes that carry a familiarity share (recipes.json:
 * Road Trip, Main Character, Feel-good, Midnight Drive). The listener's most-heard songs of the last
 * FAMILIAR_LOOKBACK_DAYS are the seeds, weighted by how often each was heard, and the songs closest to those seeds by
 * the vibe similarity every similar-song feature uses (services/matching) get a boost from 1 (closest) down to just
 * above 0 (the last of the closest FAMILIAR_SHARE of the library, at most FAMILIAR_MATCHES). The recipe adds it after its own scores are standardised
 * (recipes.ts recipeRankingSql), so it only lifts songs, never removes one, and a listener with no plays, or a library
 * with no similarity data yet, gets exactly the recipe's own ranking.
 *
 * Finding the closest songs is one exact scan of the library's sound vectors, so the result is kept in Redis for
 * FAMILIAR_CACHE_SECONDS, under a `mixes:` key so the enrichment re-run that clears the mixes cache clears it too. A
 * kept result is used only while the listener's seeds are the ones it was built from.
 */
import crypto from "crypto";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { matchingContext, topScores } from "../matching/rank";

/** Only plays this recent count: a taste is read from the recent past, and the bound lets the (user, play time) index serve the scan. */
export const FAMILIAR_LOOKBACK_DAYS = 365;
/**
 * The most seeds used. The vibe scan's sound term is a weighted sum of the seeds' vectors, so seeds beyond the most
 * heard few hundred add almost nothing to it, while each one is loaded and held in memory for the scan.
 */
export const FAMILIAR_SEEDS = 200;
/**
 * How many closest songs receive a boost, at most; every song further away gets none. A library gives it to its
 * closest FAMILIAR_SHARE (so a small library's boost stays selective), and never more than this many (so a very large
 * one still scans and ships a bounded list).
 */
export const FAMILIAR_MATCHES = 1000;
export const FAMILIAR_SHARE = 0.1;
export const FAMILIAR_CACHE_SECONDS = 3 * 3600;

/** Song ids and their boosts, 0 to 1, in matching order. */
export interface FamiliarBoost {
    ids: string[];
    boosts: number[];
}

export const familiarCacheKey = (userId: string) => `mixes:familiar:${userId}`;

interface SeedRow {
    id: string;
    plays: number;
}

/** The listener's most-heard songs of the lookback, most heard first. */
async function seedsOf(userId: string, now: Date): Promise<SeedRow[]> {
    const since = new Date(now.getTime() - FAMILIAR_LOOKBACK_DAYS * 86_400_000);
    return prisma.$queryRaw<SeedRow[]>`
        SELECT p."trackId" AS id, count(*)::int AS plays
        FROM "Play" p
        WHERE p."userId" = ${userId} AND p."playedAt" >= ${since} AND p.heard
        GROUP BY p."trackId"
        ORDER BY plays DESC, p."trackId"
        LIMIT ${FAMILIAR_SEEDS}
    `;
}

/** The boost for the songs closest to this listener's seeds, or null when there is none to give. */
export async function familiarBoost(userId: string, now = new Date()): Promise<FamiliarBoost | null> {
    const seeds = await seedsOf(userId, now);
    if (seeds.length === 0) return null;
    const signature = crypto.createHash("sha256").update(JSON.stringify(seeds)).digest("hex");

    try {
        const kept = await redisClient.get(familiarCacheKey(userId));
        if (kept) {
            const entry = JSON.parse(kept) as { signature: string; boost: FamiliarBoost | null };
            if (entry.signature === signature) return entry.boost;
        }
    } catch (error) {
        logger.debug(`[Mixes] familiarity cache unreadable: ${error instanceof Error ? error.message : error}`);
    }

    const boost = await closestToSeeds(seeds);
    try {
        await redisClient.setex(familiarCacheKey(userId), FAMILIAR_CACHE_SECONDS, JSON.stringify({ signature, boost }));
    } catch (error) {
        logger.debug(`[Mixes] familiarity cache not written: ${error instanceof Error ? error.message : error}`);
    }
    return boost;
}

/** The seeds themselves take the full boost; the other closest songs take it by rank. */
async function closestToSeeds(seeds: SeedRow[]): Promise<FamiliarBoost | null> {
    const ctx = await matchingContext(seeds.map((s) => s.id));
    if (!ctx) return null;
    const withData = seeds.filter((s) => ctx.tracks.has(s.id));
    if (withData.length === 0) return null;
    const total = withData.reduce((sum, s) => sum + s.plays, 0);
    const matches = Math.min(FAMILIAR_MATCHES, Math.max(1, Math.ceil(ctx.state.trackCount * FAMILIAR_SHARE)));
    const closest = await topScores(
        ctx,
        withData.map((s) => ({ trackId: s.id, weight: s.plays / total })),
        matches,
    );
    const boosts = new Map<string, number>();
    closest.forEach((row, rank) => boosts.set(row.id, 1 - rank / matches));
    for (const s of withData) boosts.set(s.id, 1);
    return { ids: [...boosts.keys()], boosts: [...boosts.values()] };
}
