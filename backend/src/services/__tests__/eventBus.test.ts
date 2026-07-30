/**
 * SSE event bus.
 *
 * Replaces an EventEmitter that broadcast every event to every listener, each
 * of which compared event.userId to its own and discarded the mismatches. That
 * is O(total connections) per event for a payload almost always destined for
 * one of them, and it carried setMaxListeners(100) so a hundred concurrent or
 * leaked connections started warning.
 *
 * The properties asserted here are the ones the delivery path depends on:
 * events reach only their recipient, a subscriber that refuses data is dropped
 * rather than retried forever, and a throwing subscriber cannot take the emit
 * loop down with it.
 */

import { eventBus, SSEEvent, SSESubscriber } from "../eventBus";

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function recorder(alwaysOk = true) {
    const received: SSEEvent[] = [];
    const sub: SSESubscriber = {
        send(event) {
            received.push(event);
            return alwaysOk;
        },
    };
    return { sub, received };
}

function makeEvent(userId: string, type = "scan:progress"): SSEEvent {
    return { type: type as SSEEvent["type"], userId, payload: { n: 1 } };
}

describe("eventBus delivery", () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        while (cleanups.length) cleanups.pop()!();
    });

    it("delivers only to the addressed user", () => {
        const alice = recorder();
        const bob = recorder();
        cleanups.push(eventBus.subscribe("alice", alice.sub));
        cleanups.push(eventBus.subscribe("bob", bob.sub));

        eventBus.emit(makeEvent("alice"));

        expect(alice.received).toHaveLength(1);
        expect(bob.received).toHaveLength(0);
    });

    it('delivers "*" to everyone', () => {
        const alice = recorder();
        const bob = recorder();
        cleanups.push(eventBus.subscribe("alice", alice.sub));
        cleanups.push(eventBus.subscribe("bob", bob.sub));

        eventBus.emit(makeEvent("*"));

        expect(alice.received).toHaveLength(1);
        expect(bob.received).toHaveLength(1);
    });

    it("delivers to every connection a user has open", () => {
        const tabA = recorder();
        const tabB = recorder();
        cleanups.push(eventBus.subscribe("alice", tabA.sub));
        cleanups.push(eventBus.subscribe("alice", tabB.sub));

        eventBus.emit(makeEvent("alice"));

        expect(tabA.received).toHaveLength(1);
        expect(tabB.received).toHaveLength(1);
    });

    it("emitting to nobody is not an error", () => {
        expect(() => eventBus.emit(makeEvent("ghost"))).not.toThrow();
    });

    it("stops delivering after unsubscribe", () => {
        const alice = recorder();
        const off = eventBus.subscribe("alice", alice.sub);
        eventBus.emit(makeEvent("alice"));
        off();
        eventBus.emit(makeEvent("alice"));
        expect(alice.received).toHaveLength(1);
    });
});

describe("eventBus reaping", () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        while (cleanups.length) cleanups.pop()!();
    });

    it("drops a subscriber that reports it can no longer accept data", () => {
        // This is the backpressure contract: the route returns false once the
        // socket buffer is over the cap, and the bus must stop feeding it
        // rather than queueing more into memory.
        const stalled = recorder(false);
        cleanups.push(eventBus.subscribe("alice", stalled.sub));

        eventBus.emit(makeEvent("alice"));
        eventBus.emit(makeEvent("alice"));
        eventBus.emit(makeEvent("alice"));

        // Called once, then reaped -- not retried on every subsequent event.
        expect(stalled.received).toHaveLength(1);
        expect(eventBus.connectionCount("alice")).toBe(0);
    });

    it("a throwing subscriber is dropped and does not stop the others", () => {
        const healthy = recorder();
        const thrower: SSESubscriber = {
            send() {
                throw new Error("socket exploded");
            },
        };
        cleanups.push(eventBus.subscribe("alice", thrower));
        cleanups.push(eventBus.subscribe("alice", healthy.sub));

        expect(() => eventBus.emit(makeEvent("alice"))).not.toThrow();
        expect(healthy.received).toHaveLength(1);
        expect(eventBus.connectionCount("alice")).toBe(1);
    });

    it("tracks connection counts so the route can cap them", () => {
        expect(eventBus.connectionCount("alice")).toBe(0);
        const a = recorder();
        const b = recorder();
        cleanups.push(eventBus.subscribe("alice", a.sub));
        expect(eventBus.connectionCount("alice")).toBe(1);
        cleanups.push(eventBus.subscribe("alice", b.sub));
        expect(eventBus.connectionCount("alice")).toBe(2);
    });

    it("forgets a user entirely once their last connection goes", () => {
        const a = recorder();
        const off = eventBus.subscribe("alice", a.sub);
        expect(eventBus.totalConnections()).toBeGreaterThan(0);
        off();
        expect(eventBus.connectionCount("alice")).toBe(0);
        expect(eventBus.totalConnections()).toBe(0);
    });

    it("scales fan-out with recipients, not with total connections", () => {
        // 200 connected users, one event addressed to one of them. Under the
        // old broadcast every listener ran and filtered; here only the target
        // is touched -- and 200 connections used to exceed the emitter's
        // setMaxListeners(100) warning threshold.
        const others = Array.from({ length: 200 }, (_, i) => {
            const r = recorder();
            cleanups.push(eventBus.subscribe(`user-${i}`, r.sub));
            return r;
        });
        const target = recorder();
        cleanups.push(eventBus.subscribe("target", target.sub));

        eventBus.emit(makeEvent("target"));

        expect(target.received).toHaveLength(1);
        expect(others.every((o) => o.received.length === 0)).toBe(true);
    });
});
