import { describe, expect, it } from "vitest";
import { refillAndResume, refillStation, startStationSession } from "../station-refill";
import { appendTracks, isLastInPlayOrder } from "../queue-edit";

const t = (...ids: string[]) => ids.map((id) => ({ id }));

describe("refillStation", () => {
    it("returns only tracks not already queued or played, and remembers them", async () => {
        const session = startStationSession(t("a", "b"), async () => t("b", "c", "c", "d"));
        expect(await refillStation(session, "1")).toEqual(t("c", "d"));
        expect(session.exhausted).toBe(false);
    });

    it("stops for good when a fetch brings nothing new", async () => {
        let calls = 0;
        const session = startStationSession(t("a"), async () => {
            calls++;
            return t("a");
        });
        expect(await refillStation(session, "1")).toEqual([]);
        expect(session.exhausted).toBe(true);
        expect(await refillStation(session, "2")).toEqual([]);
        expect(calls).toBe(1);
    });

    it("fetches once per queue position and never twice at once", async () => {
        let calls = 0;
        const session = startStationSession(t("a"), async () => {
            calls++;
            return t("b");
        });
        const [first, overlapping] = await Promise.all([refillStation(session, "1"), refillStation(session, "1")]);
        expect(first).toEqual(t("b"));
        expect(overlapping).toEqual([]);
        expect(await refillStation(session, "1")).toEqual([]);
        expect(calls).toBe(1);
    });

    it("does not mark the session done when a fetch fails", async () => {
        const session = startStationSession(t("a"), async () => {
            throw new Error("offline");
        });
        await expect(refillStation(session, "1")).rejects.toThrow("offline");
        expect(session.exhausted).toBe(false);
        expect(session.loading).toBe(false);
    });

    it("retries from the same position after a failed fetch", async () => {
        let calls = 0;
        const session = startStationSession(t("a"), async () => {
            if (++calls === 1) throw new Error("offline");
            return t("b");
        });
        await expect(refillStation(session, "1")).rejects.toThrow("offline");
        expect(await refillStation(session, "1")).toEqual(t("b"));
        expect(calls).toBe(2);
    });

    it("skips tracks the listener added to the queue themselves", async () => {
        const session = startStationSession(t("a"), async () => t("x", "b"));
        expect(await refillStation(session, "1", t("a", "x"))).toEqual(t("b"));
    });
});

describe("appendTracks", () => {
    it("adds to the end of the queue", () => {
        const next = appendTracks({ queue: ["a", "b"], currentIndex: 1, shuffleIndices: [], isShuffle: false }, ["c", "d"]);
        expect(next.queue).toEqual(["a", "b", "c", "d"]);
    });

    it("adds to the end of the shuffle order without reordering it", () => {
        const next = appendTracks({ queue: ["a", "b", "c"], currentIndex: 2, shuffleIndices: [1, 0, 2], isShuffle: true }, ["x", "y"]);
        expect(next.shuffleIndices).toEqual([1, 0, 2, 3, 4]);
    });
});

describe("isLastInPlayOrder", () => {
    it("is true on the last queue position when not shuffled", () => {
        expect(isLastInPlayOrder({ queue: ["a", "b"], currentIndex: 1, shuffleIndices: [], isShuffle: false })).toBe(true);
        expect(isLastInPlayOrder({ queue: ["a", "b"], currentIndex: 0, shuffleIndices: [], isShuffle: false })).toBe(false);
    });

    it("follows the shuffle order when shuffled", () => {
        const snap = { queue: ["a", "b", "c"], shuffleIndices: [1, 2, 0], isShuffle: true };
        expect(isLastInPlayOrder({ ...snap, currentIndex: 0 })).toBe(true);
        expect(isLastInPlayOrder({ ...snap, currentIndex: 2 })).toBe(false);
    });

    it("is false for an empty queue", () => {
        expect(isLastInPlayOrder({ queue: [], currentIndex: 0, shuffleIndices: [], isShuffle: false })).toBe(false);
    });
});

describe("refillAndResume", () => {
    const host = (ended: boolean, current = true) => {
        const calls = { appended: [] as { id: string }[][], started: [] as number[] };
        return {
            calls,
            host: {
                isCurrent: () => current,
                append: (tracks: { id: string }[]) => {
                    calls.appended.push(tracks);
                    return 5;
                },
                playbackEnded: () => ended,
                startAt: (i: number) => calls.started.push(i),
            },
        };
    };

    it("starts the first new track when playback had already ended", async () => {
        const session = startStationSession(t("a"), async () => t("b", "c"));
        const { calls, host: h } = host(true);
        expect(await refillAndResume(session, "1", [], h)).toBe(true);
        expect(calls.appended).toEqual([t("b", "c")]);
        expect(calls.started).toEqual([5]);
    });

    it("only appends while a track is still playing", async () => {
        const session = startStationSession(t("a"), async () => t("b"));
        const { calls, host: h } = host(false);
        expect(await refillAndResume(session, "1", [], h)).toBe(false);
        expect(calls.appended).toEqual([t("b")]);
        expect(calls.started).toEqual([]);
    });

    it("changes nothing when the station was replaced during the fetch", async () => {
        const session = startStationSession(t("a"), async () => t("b"));
        const { calls, host: h } = host(true, false);
        expect(await refillAndResume(session, "1", [], h)).toBe(false);
        expect(calls.appended).toEqual([]);
    });

    it("does not start playback when nothing new came back", async () => {
        const session = startStationSession(t("a"), async () => t("a"));
        const { calls, host: h } = host(true);
        expect(await refillAndResume(session, "1", [], h)).toBe(false);
        expect(calls.started).toEqual([]);
    });

    it("after a failed fetch tries again once per call, not on its own", async () => {
        let fetches = 0;
        const session = startStationSession(t("a"), async () => {
            fetches++;
            throw new Error("offline");
        });
        const { host: h } = host(true);
        await expect(refillAndResume(session, "1", [], h)).rejects.toThrow();
        expect(fetches).toBe(1);
        await expect(refillAndResume(session, "1", [], h)).rejects.toThrow();
        expect(fetches).toBe(2);
    });
});
