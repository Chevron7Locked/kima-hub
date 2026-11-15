/**
 * Queue entries each have their own key, so two entries of the same song stay apart: the playlist page marks only the
 * one that is playing, and the queue advances from that entry. A queue that comes from a playlist uses the playlist
 * item's id as the key; every other entry gets a generated one. Keys live in the browser only: the server's copy of the
 * queue drops them, and a queue restored from the server is keyed afresh.
 */
export interface QueueEntry {
    id: string;
    queueKey?: string;
}

// A random part per page load, so a key generated now cannot equal one from an earlier visit.
const session = Math.random().toString(36).slice(2, 8);
let counter = 0;

/** Whether the key was generated here, rather than being a playlist item's id. */
export function isGeneratedKey(queueKey: string | null | undefined): boolean {
    return !!queueKey && queueKey.startsWith("q-");
}

/** A key no entry has had before. */
export function newQueueKey(): string {
    counter += 1;
    return `q-${session}-${counter}`;
}

/**
 * The queue with every entry keyed. A key already set stays, unless an earlier entry of the same queue holds it, in
 * which case the later entry gets a new one. The same array comes back when nothing needed a key.
 */
export function withQueueKeys<T extends QueueEntry>(queue: T[]): T[] {
    const seen = new Set<string>();
    let changed = false;
    const keyed = queue.map((entry) => {
        if (entry.queueKey && !seen.has(entry.queueKey)) {
            seen.add(entry.queueKey);
            return entry;
        }
        changed = true;
        const queueKey = newQueueKey();
        seen.add(queueKey);
        return { ...entry, queueKey };
    });
    return changed ? keyed : queue;
}

/** Entries joining a queue: each gets a new key, whatever key it came with, so adding one twice makes two entries. */
export function freshQueueKeys<T extends QueueEntry>(entries: T[]): T[] {
    return entries.map((entry) => ({ ...entry, queueKey: newQueueKey() }));
}

/** The queue as the server holds it, without the keys. */
export function withoutQueueKeys<T extends QueueEntry>(queue: T[]): Omit<T, "queueKey">[] {
    return queue.map((entry) => {
        const { queueKey: _key, ...rest } = entry;
        void _key;
        return rest;
    });
}

/** Where the entry with this key sits in the queue, or -1. */
export function indexOfEntry(queue: QueueEntry[], queueKey: string | undefined): number {
    return queueKey ? queue.findIndex((entry) => entry.queueKey === queueKey) : -1;
}
