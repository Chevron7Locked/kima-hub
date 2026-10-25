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
 * kept result is used while the set of seed songs is the one it was built from; how often each was heard moves every
 * listen, so it is not part of that check, and a kept result's weights can be up to FAMILIAR_CACHE_SECONDS old.
 * Callers that ask at once (the mixes of one Home load run side by side) share one scan: in this process through one
 * shared promise per listener, across processes through a short Redis lock the others wait on. A boost is an extra, so
 * a scan that fails (or finds no similarity data yet) gives no boost, is kept only FAMILIAR_EMPTY_CACHE_SECONDS, and
 * never fails the mix that asked.
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
/** How long "no boost" is kept: a library whose similarity data is not built yet, or a scan that failed. Short, so the boost starts once it can. */
export const FAMILIAR_EMPTY_CACHE_SECONDS = 60;
/**
 * The scan lock: it expires after `lockSeconds` (so a process that died holding it blocks nobody for longer), a caller
 * that finds it held looks for the holder's result every `pollMs` for up to `waitMs`, then scans itself. An object so
 * the tests can shorten the waits.
 */
export const familiarTiming = { lockSeconds: 60, waitMs: 20_000, pollMs: 100 };

/** Song ids and their boosts, 0 to 1, in matching order. */
export interface FamiliarBoost {
    ids: string[];
    boosts: number[];
}

export const familiarCacheKey = (userId: string) => `mixes:familiar:${userId}`;
const familiarLockKey = (userId: string) => `mixes:familiar-lock:${userId}`;

export interface SeedRow {
    id: string;
    plays: number;
}

/**
 * The listener's most-heard songs of the lookback, most heard first; songs heard equally often go by the most recent
 * listen, so a light listener's seeds are what they played lately, not whichever ids sort first.
 */
export async function seedsOf(userId: string, now: Date): Promise<SeedRow[]> {
    const since = new Date(now.getTime() - FAMILIAR_LOOKBACK_DAYS * 86_400_000);
    return prisma.$queryRaw<SeedRow[]>`
        SELECT p."trackId" AS id, count(*)::int AS plays
        FROM "Play" p
        WHERE p."userId" = ${userId} AND p."playedAt" >= ${since} AND p.heard
        GROUP BY p."trackId"
        ORDER BY plays DESC, max(p."playedAt") DESC, p."trackId"
        LIMIT ${FAMILIAR_SEEDS}
    `;
}

/** Which songs are the seeds, whatever their weights. */
const signatureOf = (seeds: SeedRow[]) =>
    crypto.createHash("sha256").update(JSON.stringify(seeds.map((s) => s.id).sort())).digest("hex");

interface Kept {
    signature: string;
    boost: FamiliarBoost | null;
}

async function readKept(userId: string, signature: string): Promise<Kept | null> {
    try {
        const kept = await redisClient.get(familiarCacheKey(userId));
        if (!kept) return null;
        const entry = JSON.parse(kept) as Kept;
        return entry.signature === signature ? entry : null;
    } catch (error) {
        logger.debug(`[Mixes] familiarity cache unreadable: ${error instanceof Error ? error.message : error}`);
        return null;
    }
}

async function writeKept(userId: string, entry: Kept): Promise<void> {
    const seconds = entry.boost ? FAMILIAR_CACHE_SECONDS : FAMILIAR_EMPTY_CACHE_SECONDS;
    try {
        await redisClient.setex(familiarCacheKey(userId), seconds, JSON.stringify(entry));
    } catch (error) {
        logger.debug(`[Mixes] familiarity cache not written: ${error instanceof Error ? error.message : error}`);
    }
}

/** "mine": this caller scans; "busy": another process is scanning; "unavailable": no Redis to lock with, so scan. */
async function takeLock(userId: string): Promise<"mine" | "busy" | "unavailable"> {
    try {
        const got = await redisClient.set(familiarLockKey(userId), "1", "EX", familiarTiming.lockSeconds, "NX");
        return got === "OK" ? "mine" : "busy";
    } catch (error) {
        logger.debug(`[Mixes] familiarity lock unavailable: ${error instanceof Error ? error.message : error}`);
        return "unavailable";
    }
}

/** The result another process writes while it holds the lock, or null when it has not by the end of the wait or released without one. */
async function waitForKept(userId: string, signature: string): Promise<Kept | null> {
    const until = Date.now() + familiarTiming.waitMs;
    while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, familiarTiming.pollMs));
        const kept = await readKept(userId, signature);
        if (kept) return kept;
        try {
            if (!(await redisClient.exists(familiarLockKey(userId)))) return null;
        } catch {
            return null;
        }
    }
    return null;
}

async function resolveBoost(userId: string, now: Date): Promise<FamiliarBoost | null> {
    const seeds = await seedsOf(userId, now);
    if (seeds.length === 0) return null;
    const signature = signatureOf(seeds);

    const kept = await readKept(userId, signature);
    if (kept) return kept.boost;

    const lock = await takeLock(userId);
    try {
        if (lock === "busy") {
            const waited = await waitForKept(userId, signature);
            if (waited) return waited.boost;
        }
        let boost: FamiliarBoost | null = null;
        try {
            boost = await closestToSeeds(seeds);
        } catch (error) {
            logger.debug(`[Mixes] familiarity boost failed: ${error instanceof Error ? error.message : error}`);
        }
        await writeKept(userId, { signature, boost });
        return boost;
    } finally {
        if (lock === "mine") await redisClient.del(familiarLockKey(userId)).catch(() => undefined);
    }
}

const inFlight = new Map<string, Promise<FamiliarBoost | null>>();

/**
 * The boost for the songs closest to this listener's seeds, or null when there is none to give. Callers for one
 * listener that overlap share one run.
 */
export function familiarBoost(userId: string, now = new Date()): Promise<FamiliarBoost | null> {
    const running = inFlight.get(userId);
    if (running) return running;
    const run: Promise<FamiliarBoost | null> = resolveBoost(userId, now)
        .catch((error) => {
            logger.debug(`[Mixes] familiarity boost failed: ${error instanceof Error ? error.message : error}`);
            return null;
        })
        .finally(() => {
            if (inFlight.get(userId) === run) inFlight.delete(userId);
        });
    inFlight.set(userId, run);
    return run;
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
