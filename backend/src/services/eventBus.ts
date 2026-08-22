import { logger } from "../utils/logger";

type SSEEventType =
    | "notification"
    | "notification:cleared"
    | "download:progress"
    | "download:queued"
    | "download:complete"
    | "download:failed"
    | "search:result"
    | "search:complete"
    | "scan:progress"
    | "scan:complete"
    | "import:progress"
    | "discover:progress"
    | "discover:complete"
    | "preview:progress"
    | "preview:complete"
    | "enrichment:progress"
    | "playlist:updated";

export interface SSEEvent {
    type: SSEEventType;
    /** Recipient, or "*" to broadcast to every connected client. */
    userId: string;
    payload: Record<string, unknown>;
}

/**
 * One connected SSE client.
 *
 * `send` returns false when the connection can no longer accept data, and the
 * bus drops the subscriber -- so a dead client is reaped by the next event
 * rather than lingering until its heartbeat happens to fail.
 */
export interface SSESubscriber {
    send(event: SSEEvent): boolean;
}

/**
 * Routes events to the clients that want them.
 *
 * This was an EventEmitter that broadcast every event to every listener, each
 * of which then compared `event.userId` to its own and discarded the mismatches
 * -- O(total connections) of work per event, for a payload almost always
 * destined for exactly one of them. It also carried setMaxListeners(100), so a
 * hundred concurrent (or leaked) connections started printing warnings, and the
 * route layer separately maintained a Map of connections that was written to,
 * deleted from, and never read.
 *
 * Keying the registry by user makes delivery a single map lookup, removes the
 * listener ceiling entirely, and gives that map an actual job.
 */
class EventBus {
    private byUser = new Map<string, Set<SSESubscriber>>();

    subscribe(userId: string, subscriber: SSESubscriber): () => void {
        let set = this.byUser.get(userId);
        if (!set) {
            set = new Set();
            this.byUser.set(userId, set);
        }
        set.add(subscriber);

        return () => {
            const current = this.byUser.get(userId);
            if (!current) return;
            current.delete(subscriber);
            if (current.size === 0) this.byUser.delete(userId);
        };
    }

    /**
     * Remove a subscriber and reap the user's Set if it is now empty.
     *
     * The unsubscribe closure already did this; emit's failure path deleted the
     * subscriber but left the empty Set behind, so `byUser` grew one dead entry
     * per user whose last connection died on a failed send rather than on a
     * clean disconnect. Bounded by user count, so a slow leak rather than a bug
     * -- but two reap paths in one class should not disagree.
     */
    private drop(set: Set<SSESubscriber>, subscriber: SSESubscriber): void {
        set.delete(subscriber);
        if (set.size > 0) return;
        for (const [userId, candidate] of this.byUser) {
            if (candidate === set) {
                this.byUser.delete(userId);
                return;
            }
        }
    }

    /** How many clients this user currently has connected. */
    connectionCount(userId: string): number {
        return this.byUser.get(userId)?.size ?? 0;
    }

    /** Total connected clients, for diagnostics. */
    totalConnections(): number {
        let n = 0;
        for (const set of this.byUser.values()) n += set.size;
        return n;
    }

    emit(event: SSEEvent): void {
        const targets: Set<SSESubscriber>[] = [];
        if (event.userId === "*") {
            targets.push(...this.byUser.values());
        } else {
            const set = this.byUser.get(event.userId);
            if (set) targets.push(set);
        }

        for (const set of targets) {
            // Copy before iterating: a failed send unsubscribes, mutating the set.
            for (const subscriber of [...set]) {
                try {
                    if (!subscriber.send(event)) {
                        this.drop(set, subscriber);
                    }
                } catch (error) {
                    logger.error("[EventBus] Subscriber error:", error);
                    this.drop(set, subscriber);
                }
            }
        }
    }
}

export const eventBus = new EventBus();
