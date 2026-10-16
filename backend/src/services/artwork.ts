/**
 * The one place that looks for artwork: one ordered source list per kind of
 * thing, asked in turn behind one cache. A placeholder means every source was
 * asked and none had it.
 */

import crypto from "crypto";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { BlockedAddressError, InvalidAddressError, UnresolvedAddressError, fetchChecked } from "../utils/ssrf";
import { isMbid } from "./artistIdentity";
import { coverArtService } from "./coverArt";
import { deezerService } from "./deezer";
import { fanartService } from "./fanart";

/** Artwork for a released record does not change. */
const FOUND_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Short, because "nobody has it" is a temporary state of the world. Art gets
 * uploaded; a record out next month usually gets a cover eventually.
 */
const NONE_TTL_SECONDS = 24 * 60 * 60;

const NONE = "NONE";
const USER_AGENT = "Kima/1.0 (+https://github.com/chevron7locked/kima)";


export interface AlbumArtworkQuery {
    /** MusicBrainz release-group id, when the caller has one. */
    rgMbid?: string | null;
    artistName: string;
    albumTitle: string;
    /**
     * An address the caller was handed by something else -- Lidarr ships one
     * with its calendar. Tried last, and only after checking that it loads.
     */
    candidateUrl?: string | null;
}

export interface ArtistArtworkQuery {
    name: string;
    mbid?: string | null;
    candidateUrl?: string | null;
    /** Set on page-view calls so the fanart.tv queue runs this ahead of enrichment work. */
    interactive?: boolean;
}

export interface ArtworkResult {
    url: string;
    source: string;
}

interface Source<Q> {
    name: string;
    find: (query: Q) => Promise<string | null>;
}

/* ── the sources ─────────────────────────────────────────────────────────── */

/**
 * Order: Fanart (best artist thumbnails, skips itself without an MBID or key),
 * Deezer (most coverage, fastest), then the Cover Art Archive (authoritative but
 * slow, with gaps).
 */
const ALBUM_SOURCES: Source<AlbumArtworkQuery>[] = [
    {
        name: "deezer",
        find: (q) => deezerService.getAlbumCover(q.artistName, q.albumTitle),
    },
    {
        name: "coverartarchive",
        // coverArtService caches hits for 30 days and misses for 7, and rate-limits.
        find: (q) =>
            isMbid(q.rgMbid) ? coverArtService.getCoverArt(q.rgMbid!) : Promise.resolve(null),
    },
    {
        name: "fanart",
        find: (q) =>
            isMbid(q.rgMbid) ? fanartService.getAlbumCover(q.rgMbid!) : Promise.resolve(null),
    },
];

const ARTIST_SOURCES: Source<ArtistArtworkQuery>[] = [
    {
        name: "fanart",
        find: (q) =>
            isMbid(q.mbid)
                ? fanartService.getArtistImage(q.mbid!, { interactive: q.interactive })
                : Promise.resolve(null),
    },
    {
        name: "deezer",
        find: (q) => deezerService.getArtistImage(q.name),
    },
];

/* ── the loop ────────────────────────────────────────────────────────────── */

/**
 * Walk the sources in order and take the first real answer.
 *
 * A source that throws is logged and skipped, never fatal: one provider being
 * down must not cost us the answer another one has.
 */
async function firstAnswer<Q>(
    sources: Source<Q>[],
    query: Q,
    label: string,
): Promise<{ found: ArtworkResult | null; everyoneAnswered: boolean }> {
    let everyoneAnswered = true;

    for (const source of sources) {
        try {
            const url = await source.find(query);
            if (url) {
                logger.debug(`[Artwork] ${label}: found via ${source.name}`);
                return { found: { url, source: source.name }, everyoneAnswered: true };
            }
        } catch (error) {
            // A throw is not a "no". Carry on, but mark the run incomplete so the caller
            // never records "nobody has it" on the strength of it.
            everyoneAnswered = false;
            logger.debug(
                `[Artwork] ${label}: ${source.name} failed -- ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
    return { found: null, everyoneAnswered };
}

/**
 * Whether a picture loads at this address (one a caller was handed, never one a source returned). A timeout or
 * server error is no answer, so only a clear "not found" counts as no.
 */
async function addressLoads(url: string): Promise<boolean> {
    try {
        const response = await fetchChecked(url, {
            method: "HEAD",
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(2500),
        });
        return !(response.status === 404 || response.status === 410);
    } catch (err) {
        // Refused, not an address, or a name that does not resolve: it cannot load.
        return !(err instanceof BlockedAddressError || err instanceof InvalidAddressError || err instanceof UnresolvedAddressError);
    }
}

/* ── the cache in front ──────────────────────────────────────────────────── */

function keyFor(kind: string, identity: string): string {
    return `artwork:${kind}:${crypto.createHash("md5").update(identity).digest("hex")}`;
}

const albumKey = (q: AlbumArtworkQuery) =>
    keyFor(
        "album",
        isMbid(q.rgMbid)
            ? `rg:${q.rgMbid}`
            : `nt:${q.artistName.toLowerCase()}|${q.albumTitle.toLowerCase()}`,
    );

const artistKey = (q: ArtistArtworkQuery) =>
    keyFor("artist", isMbid(q.mbid) ? `mb:${q.mbid}` : `n:${q.name.toLowerCase()}`);

/** `undefined` means we have not asked yet; `null` means we asked and nobody had it. */
async function remembered(key: string): Promise<string | null | undefined> {
    try {
        const hit = await redisClient.get(key);
        if (hit === NONE) return null;
        if (hit) return hit;
    } catch {
        // A cache that is down means we do not know, not that there is nothing.
    }
    return undefined;
}

async function remember(key: string, url: string | null): Promise<void> {
    try {
        await redisClient.setex(key, url ? FOUND_TTL_SECONDS : NONE_TTL_SECONDS, url ?? NONE);
    } catch {
        // Losing the answer costs a repeat lookup, nothing more.
    }
}

/**
 * One lookup per record at a time: callers arriving while a lookup runs wait on
 * it, so a page of thirty covers opened by five people makes thirty calls, not
 * 150. In-process on purpose, so there is no lock to expire or leak.
 */
const inFlight = new Map<string, Promise<ArtworkResult | null>>();

function once(
    key: string,
    work: () => Promise<ArtworkResult | null>,
): Promise<ArtworkResult | null> {
    const already = inFlight.get(key);
    if (already) return already;

    const running = work().finally(() => inFlight.delete(key));
    inFlight.set(key, running);
    return running;
}

/* ── the door ────────────────────────────────────────────────────────────── */

/**
 * Find a cover for an album, from whichever source has one.
 *
 * Every caller that wants album artwork goes through here, whether the album is
 * in the library or not. Returns null only when every source has been asked.
 */
export async function findAlbumArtwork(
    query: AlbumArtworkQuery,
): Promise<ArtworkResult | null> {
    if (!query.artistName || !query.albumTitle) return null;
    return findArtwork(albumKey(query), ALBUM_SOURCES, query, `${query.artistName} - ${query.albumTitle}`);
}

/** Find an image for an artist, from whichever source has one. */
export async function findArtistArtwork(
    query: ArtistArtworkQuery,
): Promise<ArtworkResult | null> {
    if (!query.name) return null;
    return findArtwork(artistKey(query), ARTIST_SOURCES, query, query.name);
}

async function findArtwork<Q extends { candidateUrl?: string | null }>(
    key: string,
    sources: Source<Q>[],
    query: Q,
    label: string,
): Promise<ArtworkResult | null> {
    const cached = await remembered(key);
    if (cached !== undefined) {
        return cached ? { url: cached, source: "cache" } : null;
    }

    return once(key, async () => {
        const { found: fromSources, everyoneAnswered } = await firstAnswer(sources, query, label);

        let found = fromSources;
        if (!found && query.candidateUrl && (await addressLoads(query.candidateUrl))) {
            found = { url: query.candidateUrl, source: "given" };
        }

        // Only write down "nobody has it" when everybody actually said so. A
        // run where a provider was down or rate-limiting is not evidence of
        // absence, and recording it as one would blank that artwork for a day
        // over a blip. A found picture is always worth remembering.
        if (found || everyoneAnswered) {
            await remember(key, found?.url ?? null);
        }
        return found;
    });
}

/* ── a page's worth at a time ────────────────────────────────────────────── */

/** Polite to three public APIs, fast enough for a page of covers. */
const CONCURRENCY = 6;

/** How long a page will wait for covers it does not already know. */
const DEFAULT_BUDGET_MS = 3000;

/**
 * Put artwork on a list of albums, spending at most `budgetMs` on unknown ones.
 * `read` and `write` adapt the caller's shape. Whatever is unanswered at the
 * deadline is sent without art and finished in the background for the next view.
 */
export function withAlbumArtwork<T>(
    items: T[],
    read: (item: T) => AlbumArtworkQuery,
    write: (item: T, coverUrl: string | null) => T,
    options: { budgetMs?: number } = {},
): Promise<T[]> {
    return withArtwork(items, read, write, {
        usable: (q) => !!(q.artistName && q.albumTitle),
        key: albumKey,
        find: findAlbumArtwork,
        budgetMs: options.budgetMs,
    });
}

/** The same for a list of artists. */
export function withArtistArtwork<T>(
    items: T[],
    read: (item: T) => ArtistArtworkQuery,
    write: (item: T, imageUrl: string | null) => T,
    options: { budgetMs?: number } = {},
): Promise<T[]> {
    return withArtwork(items, read, write, {
        usable: (q) => !!q.name,
        key: artistKey,
        find: findArtistArtwork,
        budgetMs: options.budgetMs,
    });
}

async function withArtwork<T, Q>(
    items: T[],
    read: (item: T) => Q,
    write: (item: T, url: string | null) => T,
    how: {
        usable: (q: Q) => boolean;
        key: (q: Q) => string;
        find: (q: Q) => Promise<ArtworkResult | null>;
        budgetMs?: number;
    },
): Promise<T[]> {
    if (items.length === 0) return items;

    const budgetMs = how.budgetMs ?? DEFAULT_BUDGET_MS;
    const queries = items.map(read);
    const answers = new Map<string, string | null>();

    // One lookup per distinct record, however many times it is listed.
    const distinct = new Map<string, Q>();
    for (const q of queries) {
        if (how.usable(q)) distinct.set(how.key(q), q);
    }

    const unresolved: [string, Q][] = [];
    await Promise.all(
        [...distinct].map(async ([key, q]) => {
            const hit = await remembered(key);
            if (hit === undefined) unresolved.push([key, q]);
            else answers.set(key, hit);
        }),
    );

    // Unanswered at the deadline: send nothing rather than the caller's candidate,
    // which is an unchecked address that may 404 in the browser. The background
    // lookups fix it on the next view.
    for (const [key] of unresolved) answers.set(key, null);

    const deadline = Date.now() + budgetMs;
    const queue = [...unresolved];
    const leftover: Q[] = [];

    const worker = async () => {
        for (;;) {
            const next = queue.shift();
            if (!next) return;
            const [key, q] = next;
            if (Date.now() >= deadline) {
                leftover.push(q);
                continue;
            }
            const found = await how.find(q).catch(() => null);
            answers.set(key, found?.url ?? null);
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    if (leftover.length > 0) {
        logger.debug(
            `[Artwork] ${leftover.length} images ran past the ${budgetMs}ms budget; finishing in the background`,
        );
        void finishLater(leftover, how.find);
    }

    return items.map((item, i) => {
        const q = queries[i];
        if (!how.usable(q)) return write(item, null);
        return write(item, answers.get(how.key(q)) ?? null);
    });
}

/** Answer the stragglers after the response has gone, so the next view is right. */
async function finishLater<Q>(pending: Q[], find: (q: Q) => Promise<ArtworkResult | null>): Promise<void> {
    const queue = [...pending];
    const worker = async () => {
        for (;;) {
            const q = queue.shift();
            if (!q) return;
            try {
                await find(q);
            } catch (error) {
                logger.debug(`[Artwork] Background lookup failed: ${String(error)}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}
