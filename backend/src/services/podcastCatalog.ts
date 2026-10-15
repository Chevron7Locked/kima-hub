/**
 * Apple's podcast catalog as Kima reads it: the category tree, per-category charts, and each show's own
 * categories. Discovery runs on these tags, never on keyword searches. Every Apple request is cached in
 * Redis and goes through the iTunes rate limiter.
 */
import axios from "axios";
import { redisClient } from "../utils/redis";
import { rateLimiter } from "./rateLimiter";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

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
async function apple<T = any>(pathname: string, params?: Record<string, string | number>): Promise<T> {
    const base = process.env.ITUNES_BASE_URL ?? "https://itunes.apple.com";
    return (await axios.get(base + pathname, { params, timeout: 15000 })).data;
}

async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    try {
        const hit = await redisClient.get(key);
        if (hit) return JSON.parse(hit) as T;
    } catch (err) {
        logger.warn(`[PodcastCatalog] Redis read failed for ${key}: ${(err as Error).message}`);
    }
    const value = await rateLimiter.execute("itunes", load);
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
        return out;
    });
}

/** Apple's chart for one category (the overall chart without one), in rank order, up to 200 shows. */
export async function chart(categoryId: number | null): Promise<CatalogPodcast[]> {
    const country = await chartCountry();
    const genre = categoryId ? `/genre=${categoryId}` : "";
    return cached(`podcasts:chart:v1:${country}:${categoryId ?? "all"}`, 6 * 3600, async () => {
        const data = await apple(`/${country}/rss/toppodcasts/limit=${CHART_MAX}${genre}/json`);
        const entries: any[] = data?.feed?.entry ?? [];
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
    });
}

/** Apple's record for each show id: its feed and categories. Ids Apple does not know are left out. */
export async function lookupShows(itunesIds: string[]): Promise<Map<string, LookupShow>> {
    const out = new Map<string, LookupShow>();
    const ids = [...new Set(itunesIds.filter((id) => /^\d+$/.test(id)))];
    for (const id of ids) {
        const show = await cached(`podcasts:lookup:v2:${id}`, 7 * DAY, async (): Promise<LookupShow | null> => {
            const data = await apple("/lookup", { id, entity: "podcast" });
            const r = data?.results?.[0];
            return r
                ? {
                      itunesId: String(r.collectionId),
                      feedUrl: r.feedUrl ?? null,
                      categoryIds: categoryIdsFrom(r.genreIds),
                      title: r.collectionName ?? "",
                      author: r.artistName ?? "",
                      coverUrl: r.artworkUrl600 || r.artworkUrl100 || null,
                      episodeCount: r.trackCount || 0,
                  }
                : null;
        });
        if (show) out.set(id, show);
    }
    return out;
}

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
export async function assignCategories(podcastId: string, itunesId: string | null, feedCategoryNames: string[] = []): Promise<number[]> {
    try {
        let ids: number[] = [];
        if (itunesId) ids = (await lookupShows([itunesId])).get(itunesId)?.categoryIds ?? [];
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
    let filled = 0;
    for (const s of shows) {
        if ((await assignCategories(s.id, s.itunesId)).length > 0) filled++;
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
 * Shows like this one: those on the charts of its own categories (most specific first), ranked by how many
 * of those charts they share with it, then by their best chart position.
 */
export async function similarShows(show: { itunesId: string | null; categoryIds: number[] }, limit = 12): Promise<DiscoveryItem[]> {
    const found = new Map<string, { show: CatalogPodcast; shared: number; best: number }>();
    for (const id of show.categoryIds.slice(0, 3)) {
        for (const p of await chart(id)) {
            if (p.itunesId === show.itunesId) continue;
            const hit = found.get(p.itunesId) ?? { show: p, shared: 0, best: Infinity };
            hit.shared++;
            hit.best = Math.min(hit.best, p.chartRank ?? Infinity);
            found.set(p.itunesId, hit);
        }
    }
    const ranked = [...found.values()].sort((a, b) => b.shared - a.shared || a.best - b.best).slice(0, limit);
    return toDiscoveryItems(ranked.map((r) => r.show));
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
