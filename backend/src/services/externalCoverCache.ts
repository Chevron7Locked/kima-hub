/**
 * Pictures held at other sites, served by the Subsonic cover route as Kima's own. An app asks for every cover on a page at
 * once, and asks again on the next visit, so without a memory of them each ask would be a fetch from another site. A
 * picture is kept per address and width for a few hours, in process, within a small bound: a count of pictures and a total
 * of bytes, the oldest dropped first, and a picture too big to be a fair share is served and not kept. A failure is never
 * kept (the next ask tries the site again), and asks that arrive together for the same picture share one fetch.
 *
 * The interface is `externalCoverPicture`; a stored cover does not come through here (it is a file already).
 */

import { fetchPicture, resizeImageBuffer } from "./imageStorage";

export interface ExternalCoverPicture {
    bytes: Buffer;
    contentType: string;
}

/** The bound: how long, how many pictures, how many bytes in all, and the most one picture may be to be kept. */
export const EXTERNAL_COVER_CACHE = {
    ttlMs: 6 * 60 * 60 * 1000,
    maxEntries: 200,
    maxBytes: 32 * 1024 * 1024,
    maxEntryBytes: 4 * 1024 * 1024,
} as const;

interface Entry {
    picture: ExternalCoverPicture;
    expiresAt: number;
}

/** In the order they were kept, so the first key is the oldest. */
const kept = new Map<string, Entry>();
let keptBytes = 0;
const inFlight = new Map<string, Promise<ExternalCoverPicture | null>>();

function drop(key: string): void {
    const entry = kept.get(key);
    if (!entry) return;
    kept.delete(key);
    keptBytes -= entry.picture.bytes.length;
}

function keep(key: string, picture: ExternalCoverPicture): void {
    if (picture.bytes.length > EXTERNAL_COVER_CACHE.maxEntryBytes) return;
    drop(key);
    kept.set(key, { picture, expiresAt: Date.now() + EXTERNAL_COVER_CACHE.ttlMs });
    keptBytes += picture.bytes.length;
    while (kept.size > EXTERNAL_COVER_CACHE.maxEntries || keptBytes > EXTERNAL_COVER_CACHE.maxBytes) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
    }
}

/** Empties the memory. For tests, which share one process. */
export function clearExternalCoverCache(): void {
    kept.clear();
    keptBytes = 0;
    inFlight.clear();
}

/**
 * The picture at `url`, scaled to `width` (a whole width the caller has checked; null for the whole picture), from memory
 * when it is there and not too old, else fetched through the address guard. Null when the site cannot give a picture.
 */
export async function externalCoverPicture(url: string, width: number | null): Promise<ExternalCoverPicture | null> {
    const key = `${width ?? "whole"}|${url}`;
    const hit = kept.get(key);
    if (hit) {
        if (hit.expiresAt > Date.now()) return hit.picture;
        drop(key);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    const fetched = (async () => {
        const picture = await fetchPicture(url);
        if (!picture) return null;
        const scaled = width ? await resizeImageBuffer(picture.bytes, width) : picture.bytes;
        const result = { bytes: scaled, contentType: scaled === picture.bytes ? picture.contentType : "image/jpeg" };
        keep(key, result);
        return result;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, fetched);
    return fetched;
}
