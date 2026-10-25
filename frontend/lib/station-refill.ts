/**
 * A station keeps playing by fetching another batch whenever its queue runs out.
 * The session remembers every track id it has queued, so a refill adds only tracks
 * not already played or queued, and it ends when a fetch brings nothing new. A station
 * the server orders (`serverOrdered`, stationBatches) never repeats a song until it has
 * played them all and then starts over on purpose, so its refills are taken whole and it
 * ends only when a fetch brings nothing.
 */
export interface StationSession<T extends { id: string }> {
    fetchBatch: () => Promise<T[]>;
    serverOrdered: boolean;
    seen: Set<string>;
    exhausted: boolean;
    loading: boolean;
    /**
     * The queue position a refill was last tried from, so one track start triggers one fetch. A refill that
     * adds tracks clears it: the queue only ends there again if the listener removes them, and then it needs more.
     */
    triggeredFor: string | null;
}

export function startStationSession<T extends { id: string }>(
    queued: T[],
    fetchBatch: () => Promise<T[]>,
    { serverOrdered = false }: { serverOrdered?: boolean } = {},
): StationSession<T> {
    return {
        fetchBatch,
        serverOrdered,
        seen: new Set(queued.map((t) => t.id)),
        exhausted: false,
        loading: false,
        triggeredFor: null,
    };
}

/**
 * Returns the new tracks to append: none when the session is done, busy, or already tried from this position.
 * Every id in `queuedNow` counts as seen, so tracks the listener added to the queue are not added again.
 * A failed fetch lets the next call from the same position try again.
 */
export async function refillStation<T extends { id: string }>(
    session: StationSession<T>,
    triggerKey: string,
    queuedNow: Iterable<{ id: string }> = [],
): Promise<T[]> {
    if (session.exhausted || session.loading || session.triggeredFor === triggerKey) return [];
    session.triggeredFor = triggerKey;
    session.loading = true;
    for (const track of queuedNow) session.seen.add(track.id);
    try {
        const fresh: T[] = [];
        for (const track of await session.fetchBatch()) {
            if (!session.serverOrdered && session.seen.has(track.id)) continue;
            session.seen.add(track.id);
            fresh.push(track);
        }
        if (fresh.length === 0) session.exhausted = true;
        else session.triggeredFor = null;
        return fresh;
    } catch (error) {
        session.triggeredFor = null;
        throw error;
    } finally {
        session.loading = false;
    }
}

export interface StationHost<T> {
    /** False once the station was replaced or cleared, so a late fetch changes nothing. */
    isCurrent: () => boolean;
    /** Appends to the live queue and returns the queue length before the append. */
    append: (tracks: T[]) => number;
    /** True when playback stopped by itself at the end of the queue (not paused by the listener). */
    playbackEnded: () => boolean;
    startAt: (index: number) => void;
}

/** Refills the station; if the queue had already finished playing, starts the first new track. Returns whether it did. */
export async function refillAndResume<T extends { id: string }>(
    session: StationSession<T>,
    triggerKey: string,
    queuedNow: Iterable<{ id: string }>,
    host: StationHost<T>,
): Promise<boolean> {
    const fresh = await refillStation(session, triggerKey, queuedNow);
    if (fresh.length === 0 || !host.isCurrent()) return false;
    const firstNew = host.append(fresh);
    if (!host.playbackEnded()) return false;
    host.startAt(firstNew);
    return true;
}

/**
 * A station's batches from the server. The server plays a station in its own order, spreading each artist's songs, and
 * for the stations that play every matching song (moods, Wildcard, workout) one order per seed: when a batch comes back
 * with `next`, the next fetch asks from there with the same seed, so refills carry on through that order instead of
 * starting a fresh one and losing the spread to the repeats a session drops. Such a station is `serverOrdered`.
 */
export function stationBatches<T>(
    get: (query: string) => Promise<{ tracks: T[]; next?: number }>,
    params: URLSearchParams,
    // Not crypto.randomUUID: it exists only on HTTPS pages, and many servers are reached over plain HTTP.
    seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
): () => Promise<{ tracks: T[]; next?: number }> {
    const query = new URLSearchParams(params);
    query.set("seed", seed);
    return async () => {
        const batch = await get(query.toString());
        if (batch.next !== undefined) query.set("offset", String(batch.next));
        return batch;
    };
}
