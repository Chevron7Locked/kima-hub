/**
 * Apple's podcast catalog as Kima reads it: the category tree, per-category charts, and each show's own
 * categories. Discovery runs on these tags, never on keyword searches. Every Apple request is cached in
 * Redis and goes through the iTunes rate limiter.
 */
import axios from "axios";
import { redisClient } from "../utils/redis";
import { INTERACTIVE_PRIORITY, rateLimiter, type QueueTicket } from "./rateLimiter";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { UpstreamReplyError } from "../utils/upstream";

/** Apple's root "Podcasts" genre: every show carries it, so it says nothing. */
const ROOT_GENRE = 26;
/** Apple's chart feed serves at most 200 shows per chart. */
export const CHART_MAX = 200;
const DAY = 86400;

export interface PodcastCategory {
    id: number;
    name: string;
    parentId: number | null;
}

/** One show as discovery lists it; `id` is its Apple id, which the preview and subscribe routes take. */
export interface CatalogPodcast {
    id: string;
    itunesId: string;
    title: string;
    author: string;
    description: string;
    coverUrl: string | null;
    categoryIds: number[];
    chartRank: number | null;
    isExternal: true;
}

export interface LookupShow {
    itunesId: string;
    feedUrl: string | null;
    categoryIds: number[];
    title: string;
    author: string;
    coverUrl: string | null;
    episodeCount: number;
}

/** The episode a show is sampled by: its oldest in the feed, where hosts usually say what the show is. */
export interface Snippet {
    title: string;
    publishedAt: string;
    duration: number;
    description: string;
    audioUrl: string;
}

// ITUNES_BASE_URL points tests at recorded replies (scripts/record-apple-podcasts.ts).
async function apple<T = any>(
    pathname: string,
    params?: Record<string, string | number>,
    timeout = 15000,
    signal?: AbortSignal,
): Promise<T> {
    const base = process.env.ITUNES_BASE_URL ?? "https://itunes.apple.com";
    return (await axios.get(base + pathname, { params, timeout, signal })).data;
}

/** Apple answered, but not with what was asked for (an error page, a throttled empty reply). Never cached. */
export class AppleReplyError extends UpstreamReplyError {
    name = "AppleReplyError";
}

/** Whether Apple has a podcast category with this id. */
export async function isCategory(id: number): Promise<boolean> {
    return (await categoryTree()).some((c) => c.id === id);
}

/**
 * Kima's requests to Apple share one queue per server, one request every 3 s. A request a person is waiting on
 * (a show page, the top shows, "for you") goes first; work that can wait (the podcasts page's category rows, the
 * category fill-in at start) goes after it.
 */
export type ApplePriority = "interactive" | "background";
const QUEUE_PRIORITY: Record<ApplePriority, number> = { interactive: INTERACTIVE_PRIORITY, background: 0 };

/**
 * Loads still waiting on Apple, by cache key: a later asker (another row, a retry, another user) shares the first
 * one's request instead of sending its own. A person joining background work raises it to the front, so they never
 * wait behind the rows and Apple is still asked once.
 */
const inFlight = new Map<string, { loading: Promise<unknown>; ticket: QueueTicket }>();

async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>, priority: ApplePriority = "interactive"): Promise<T> {
    const pending = inFlight.get(key);
    if (pending) {
        rateLimiter.raise("itunes", pending.ticket, QUEUE_PRIORITY[priority]);
        return pending.loading as Promise<T>;
    }
    const ticket: QueueTicket = { priority: QUEUE_PRIORITY[priority], waitingId: null };
    const loading = cachedOnce(key, ttlSeconds, load, ticket).finally(() => inFlight.delete(key));
    inFlight.set(key, { loading, ticket });
    return loading;
}

async function cachedOnce<T>(key: string, ttlSeconds: number, load: () => Promise<T>, ticket: QueueTicket): Promise<T> {
    try {
        const hit = await redisClient.get(key);
        if (hit) return JSON.parse(hit) as T;
    } catch (err) {
        logger.warn(`[PodcastCatalog] Redis read failed for ${key}: ${(err as Error).message}`);
    }
    const value = await rateLimiter.execute("itunes", load, { ticket });
    try {
        await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
    } catch (err) {
        logger.warn(`[PodcastCatalog] Redis write failed for ${key}: ${(err as Error).message}`);
    }
    return value;
}

/** Apple's genre ids for a show, most specific first, without the root. */
export function categoryIdsFrom(genreIds: unknown): number[] {
    if (!Array.isArray(genreIds)) return [];
    return genreIds.map((g) => Number(g)).filter((g) => Number.isInteger(g) && g !== ROOT_GENRE);
}

/** Apple's artwork urls carry their size; ask for a size a page can show sharply. */
function largeArtwork(url: string | undefined | null): string | null {
    if (!url) return null;
    return url.replace(/\/\d+x\d+bb\./, "/600x600bb.");
}

async function chartCountry(): Promise<string> {
    const settings = await getSystemSettings();
    const cc = (settings?.podcastChartCountry ?? "us").toLowerCase();
    return /^[a-z]{2}$/.test(cc) ? cc : "us";
}

/** Every podcast category Apple has, top-level and sub-categories, flattened. */
export async function categoryTree(): Promise<PodcastCategory[]> {
    return cached("podcasts:categories:v1", 7 * DAY, async () => {
        const data = await apple("/WebObjects/MZStoreServices.woa/ws/genres", { id: ROOT_GENRE });
        const root = data?.[String(ROOT_GENRE)];
        const out: PodcastCategory[] = [];
        for (const [id, top] of Object.entries<any>(root?.subgenres ?? {})) {
            out.push({ id: Number(id), name: top.name, parentId: null });
            for (const [subId, sub] of Object.entries<any>(top.subgenres ?? {})) {
                out.push({ id: Number(subId), name: sub.name, parentId: Number(id) });
            }
        }
        if (out.length === 0) throw new AppleReplyError("Apple's category list came back empty");
        return out;
    });
}

/** Apple's chart for one category (the overall chart without one), in rank order, up to 200 shows. */
export async function chart(categoryId: number | null, priority: ApplePriority = "interactive"): Promise<CatalogPodcast[]> {
    const country = await chartCountry();
    const genre = categoryId ? `/genre=${categoryId}` : "";
    return cached(`podcasts:chart:v1:${country}:${categoryId ?? "all"}`, 6 * 3600, async () => {
        const data = await apple(`/${country}/rss/toppodcasts/limit=${CHART_MAX}${genre}/json`);
        if (!data?.feed) throw new AppleReplyError("Apple's chart reply had no feed");
        // An empty chart has no entry; a chart of one has an object, not a list.
        const entry = data.feed.entry;
        const entries: any[] = Array.isArray(entry) ? entry : entry ? [entry] : [];
        return entries.map((e, i): CatalogPodcast => {
            const itunesId = String(e?.id?.attributes?.["im:id"] ?? "");
            const images: any[] = e?.["im:image"] ?? [];
            const category = Number(e?.category?.attributes?.["im:id"]);
            return {
                id: itunesId,
                itunesId,
                title: e?.["im:name"]?.label ?? "",
                author: e?.["im:artist"]?.label ?? "",
                description: e?.summary?.label ?? "",
                coverUrl: largeArtwork(images[images.length - 1]?.label),
                categoryIds: Number.isInteger(category) && category !== ROOT_GENRE ? [category] : [],
                chartRank: i + 1,
                isExternal: true,
            };
        }).filter((p) => p.itunesId);
    }, priority);
}

const SEARCH_DEADLINE_MS = 5000;

/**
 * Apple's podcast search for a term, as Apple answers it (the caller shapes and caches the shows). It queues with
 * Kima's other Apple requests, ahead of background work, so a search counts against Apple's limit like the rest.
 * The whole search, queue wait included, gets 5 s as it always had; past that it gives up and is never sent, and a
 * rate-limited search fails at once rather than waiting out a backoff.
 */
export async function searchShows(term: string, limit: number): Promise<any[]> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("Apple podcast search took longer than 5 s")), SEARCH_DEADLINE_MS);
    try {
        const data = await rateLimiter.execute(
            "itunes",
            () => apple("/search", { term, media: "podcast", entity: "podcast", limit }, SEARCH_DEADLINE_MS, deadline.signal),
            { priority: QUEUE_PRIORITY.interactive, skipRetry: true, signal: deadline.signal },
        );
        return Array.isArray(data?.results) ? data.results : [];
    } finally {
        clearTimeout(timer);
    }
}

/** Apple's record for each show id: its feed and categories. Ids Apple does not know are left out. */
export async function lookupShows(itunesIds: string[], priority: ApplePriority = "interactive"): Promise<Map<string, LookupShow>> {
    const out = new Map<string, LookupShow>();
    const ids = [...new Set(itunesIds.filter((id) => /^\d+$/.test(id)))];
    const missing: string[] = [];
    for (const id of ids) {
        try {
            const hit = await redisClient.get(lookupKey(id));
            if (hit) {
                const show = JSON.parse(hit) as LookupShow | null;
                if (show) out.set(id, show);
                continue;
            }
        } catch (err) {
            logger.warn(`[PodcastCatalog] Redis read failed for ${lookupKey(id)}: ${(err as Error).message}`);
        }
        missing.push(id);
    }
    // Apple answers up to 200 ids in one lookup; ids it does not know are remembered as unknown.
    for (let i = 0; i < missing.length; i += LOOKUP_BATCH) {
        const batch = missing.slice(i, i + LOOKUP_BATCH);
        const data = await rateLimiter.execute("itunes", () => apple("/lookup", { id: batch.join(","), entity: "podcast" }), {
            priority: QUEUE_PRIORITY[priority],
        });
        // Ids missing from a well-formed reply are unknown to Apple; a reply without a results list says nothing.
        if (!Array.isArray(data?.results)) throw new AppleReplyError("Apple's lookup reply had no results list");
        const found = new Map<string, LookupShow>();
        for (const r of data.results) {
            if (r?.kind !== "podcast") continue;
            found.set(String(r.collectionId), {
                itunesId: String(r.collectionId),
                feedUrl: r.feedUrl ?? null,
                categoryIds: categoryIdsFrom(r.genreIds),
                title: r.collectionName ?? "",
                author: r.artistName ?? "",
                coverUrl: r.artworkUrl600 || r.artworkUrl100 || null,
                episodeCount: r.trackCount || 0,
            });
        }
        for (const id of batch) {
            const show = found.get(id) ?? null;
            if (show) out.set(id, show);
            try {
                await redisClient.setex(lookupKey(id), 7 * DAY, JSON.stringify(show));
            } catch (err) {
                logger.warn(`[PodcastCatalog] Redis write failed for ${lookupKey(id)}: ${(err as Error).message}`);
            }
        }
    }
    return out;
}

const LOOKUP_BATCH = 200;
const lookupKey = (id: string) => `podcasts:lookup:v3:${id}`;

/** A feed's own `itunes:category` names, mapped onto Apple's ids; names Apple does not use are dropped. */
export async function categoryIdsForNames(names: string[]): Promise<number[]> {
    if (names.length === 0) return [];
    const byName = new Map((await categoryTree()).map((c) => [c.name.toLowerCase(), c.id]));
    const ids = names.map((n) => byName.get(n.toLowerCase())).filter((id): id is number => id !== undefined);
    return [...new Set(ids)];
}

/**
 * Store a show's categories: Apple's record when the show has an Apple id, else its feed's own tags.
 * Never fails the caller; a show Apple cannot answer for keeps what it had.
 */
export async function assignCategories(
    podcastId: string,
    itunesId: string | null,
    feedCategoryNames: string[] = [],
    priority: ApplePriority = "interactive",
): Promise<number[]> {
    try {
        let ids: number[] = [];
        if (itunesId) ids = (await lookupShows([itunesId], priority)).get(itunesId)?.categoryIds ?? [];
        if (ids.length === 0) ids = await categoryIdsForNames(feedCategoryNames);
        if (ids.length > 0) {
            await prisma.podcast.updateMany({ where: { id: podcastId }, data: { categoryIds: ids } });
        }
        return ids;
    } catch (err) {
        logger.warn(`[PodcastCatalog] Could not assign categories to ${podcastId}: ${(err as Error).message}`);
        return [];
    }
}

/** Shows stored before categories were kept: fill the ones Apple can name. */
export async function assignMissingCategories(): Promise<number> {
    const shows = await prisma.podcast.findMany({
        where: { categoryIds: { isEmpty: true }, itunesId: { not: null } },
        select: { id: true, itunesId: true },
    });
    // One batched lookup (200 shows a request) fills the cache each assignment then reads; if Apple fails here,
    // each assignment asks again and copes on its own.
    await lookupShows(shows.map((s) => s.itunesId!), "background").catch((err) =>
        logger.warn(`[PodcastCatalog] Batched lookup for the category backfill failed: ${(err as Error).message}`),
    );
    let filled = 0;
    for (const s of shows) {
        if ((await assignCategories(s.id, s.itunesId, [], "background")).length > 0) filled++;
    }
    if (filled > 0) logger.info(`[PodcastCatalog] Categories filled for ${filled} podcast(s)`);
    return filled;
}

/** A show as the discovery endpoints answer it; the older fields stay so existing clients keep decoding. */
export interface DiscoveryItem {
    id: string;
    itunesId: string;
    title: string;
    author: string;
    description: string;
    coverUrl: string | null;
    feedUrl: string | null;
    genres: string[];
    categoryIds: number[];
    episodeCount: number;
    chartRank: number | null;
    isExternal: true;
}

export async function toDiscoveryItems(shows: CatalogPodcast[]): Promise<DiscoveryItem[]> {
    const names = new Map((await categoryTree()).map((c) => [c.id, c.name]));
    return shows.map((p) => ({
        id: p.itunesId,
        itunesId: p.itunesId,
        title: p.title,
        author: p.author,
        description: p.description,
        coverUrl: p.coverUrl,
        feedUrl: null,
        genres: p.categoryIds.map((id) => names.get(id)).filter((n): n is string => Boolean(n)),
        categoryIds: p.categoryIds,
        episodeCount: 0,
        chartRank: p.chartRank,
        isExternal: true,
    }));
}

export interface ForYouRow {
    category: PodcastCategory;
    /** The followed shows that put this category here. */
    because: string[];
    podcasts: DiscoveryItem[];
}

/**
 * Rows built from what the user follows: the categories their shows carry (sub-categories and each show's
 * primary category weigh most), each row that category's chart minus shows already followed.
 */
export async function forYou(userId: string, rows = 3, perRow = 12): Promise<ForYouRow[]> {
    const subs = await prisma.podcastSubscription.findMany({
        where: { userId },
        select: { podcast: { select: { title: true, itunesId: true, categoryIds: true } } },
    });
    const tree = await categoryTree();
    const byId = new Map(tree.map((c) => [c.id, c]));
    const weight = new Map<number, { score: number; because: string[] }>();
    for (const { podcast } of subs) {
        podcast.categoryIds.forEach((id, position) => {
            const category = byId.get(id);
            if (!category) return;
            const w = weight.get(id) ?? { score: 0, because: [] };
            w.score += (category.parentId !== null ? 2 : 1) / (position + 1);
            w.because.push(podcast.title);
            weight.set(id, w);
        });
    }
    const followed = new Set(subs.map((s) => s.podcast.itunesId).filter(Boolean));
    const picked = [...weight.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, rows);
    const out: ForYouRow[] = [];
    for (const [id, w] of picked) {
        const shows = (await chart(id)).filter((p) => !followed.has(p.itunesId)).slice(0, perRow);
        if (shows.length === 0) continue;
        out.push({ category: byId.get(id)!, because: [...new Set(w.because)].slice(0, 2), podcasts: await toDiscoveryItems(shows) });
    }
    return out;
}

/**
 * Shows like this one: those on its categories' charts, closest category list first (categories both carry over
 * categories either carries, from Apple's full list for each show), then chart order.
 */
export async function similarShows(show: { itunesId: string | null; categoryIds: number[] }, limit = 12): Promise<DiscoveryItem[]> {
    const target = new Set(show.categoryIds);
    const seen = new Set<string>();
    const candidates: CatalogPodcast[] = [];
    for (const id of show.categoryIds) {
        for (const p of await chart(id)) {
            if (p.itunesId === show.itunesId || seen.has(p.itunesId)) continue;
            seen.add(p.itunesId);
            candidates.push(p);
        }
    }
    const looked = await lookupShows(candidates.map((p) => p.itunesId));
    const closeness = (p: CatalogPodcast) => {
        const own = new Set(looked.get(p.itunesId)?.categoryIds ?? p.categoryIds);
        const shared = [...own].filter((id) => target.has(id)).length;
        return shared / new Set([...own, ...target]).size;
    };
    const ranked = candidates
        .map((p, order) => ({ p, order, closeness: closeness(p) }))
        .sort((a, b) => b.closeness - a.closeness || a.order - b.order);
    return toDiscoveryItems(ranked.slice(0, limit).map((r) => r.p));
}

/** The oldest episode in a parsed feed, or none when the feed carries no dated audio. */
export function oldestEpisode<T extends { publishedAt: Date; audioUrl: string }>(episodes: T[]): T | null {
    let oldest: T | null = null;
    for (const ep of episodes) {
        if (!ep.audioUrl || Number.isNaN(ep.publishedAt.getTime())) continue;
        if (!oldest || ep.publishedAt < oldest.publishedAt) oldest = ep;
    }
    return oldest;
}

const snippetKey = (itunesId: string) => `podcasts:snippet:v1:${itunesId}`;

/** Keep a show's snippet once a preview has read its feed, so the stream does not read the feed again. */
export async function rememberSnippet(itunesId: string, snippet: Snippet): Promise<void> {
    try {
        await redisClient.setex(snippetKey(itunesId), DAY, JSON.stringify(snippet));
    } catch (err) {
        logger.warn(`[PodcastCatalog] Could not keep the snippet for ${itunesId}: ${(err as Error).message}`);
    }
}

/** A show's snippet: remembered from its preview, or read from its feed now. */
export async function snippetFor(itunesId: string, readFeed: (feedUrl: string) => Promise<Snippet | null>): Promise<Snippet | null> {
    try {
        const kept = await redisClient.get(snippetKey(itunesId));
        if (kept) return JSON.parse(kept) as Snippet;
    } catch (err) {
        logger.warn(`[PodcastCatalog] Redis read failed for ${snippetKey(itunesId)}: ${(err as Error).message}`);
    }
    const feedUrl = (await lookupShows([itunesId])).get(itunesId)?.feedUrl;
    if (!feedUrl) return null;
    const snippet = await readFeed(feedUrl);
    if (snippet) await rememberSnippet(itunesId, snippet);
    return snippet;
}
