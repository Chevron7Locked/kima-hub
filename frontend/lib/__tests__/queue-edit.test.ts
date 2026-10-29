import { describe, expect, it } from "vitest";
import { appendTracks, insertTrack, isLastInPlayOrder, removeTrack } from "../queue-edit";

const snap = (queue: string[], currentIndex: number, shuffleIndices: number[] = [], isShuffle = false) => ({
    queue,
    currentIndex,
    shuffleIndices,
    isShuffle,
});

describe("insertTrack", () => {
    it("inserts at the up-next cursor and advances it", () => {
        const first = insertTrack(snap(["a", "b", "c"], 0), { upNextAt: 1, shufflePos: 0 }, "x");
        expect(first.queue).toEqual(["a", "x", "b", "c"]);
        expect(first.upNextAt).toBe(2);

        const second = insertTrack(snap(first.queue, 0), { upNextAt: first.upNextAt, shufflePos: 0 }, "y");
        expect(second.queue).toEqual(["a", "x", "y", "b", "c"]);
    });

    it("clamps a cursor past the end", () => {
        expect(insertTrack(snap(["a"], 0), { upNextAt: 9, shufflePos: 0 }, "x").queue).toEqual(["a", "x"]);
    });

    it("plays the new track next in shuffle order", () => {
        const next = insertTrack(snap(["a", "b", "c"], 0, [2, 0, 1], true), { upNextAt: 1, shufflePos: 0 }, "x");
        expect(next.queue).toEqual(["a", "x", "b", "c"]);
        expect(next.shuffleIndices).toEqual([3, 0, 1, 2]);
        expect(next.shufflePos).toBe(3);
    });

    it("leaves shuffle order alone when shuffle is off", () => {
        expect(insertTrack(snap(["a"], 0, [0]), { upNextAt: 1, shufflePos: 0 }, "x").shuffleIndices).toEqual([0]);
    });

    it("does not change its input", () => {
        const input = snap(["a", "b"], 0, [1, 0], true);
        insertTrack(input, { upNextAt: 1, shufflePos: 0 }, "x");
        expect(input).toEqual(snap(["a", "b"], 0, [1, 0], true));
    });
});

describe("removeTrack", () => {
    const cur = { upNextAt: 0, shufflePos: 0 };

    it("pulls the up-next cursor back when a track before it goes", () => {
        const added = insertTrack(snap(["a", "b"], 0), { upNextAt: 1, shufflePos: 0 }, "x");
        const withY = insertTrack(snap(added.queue, 0), { upNextAt: added.upNextAt, shufflePos: 0 }, "y");
        const removed = removeTrack(snap(withY.queue, 0), { upNextAt: withY.upNextAt, shufflePos: 0 }, 1);
        const next = insertTrack(snap(removed.queue, 0), { upNextAt: removed.upNextAt, shufflePos: 0 }, "z");
        expect(next.queue).toEqual(["a", "y", "z", "b"]);
    });

    it("leaves the cursor alone when a track after it goes", () => {
        expect(removeTrack(snap(["a", "x", "b"], 0), { upNextAt: 2, shufflePos: 0 }, 2).upNextAt).toBe(2);
    });

    it("pulls the shuffle cursor back when a track before it in play order goes", () => {
        const next = removeTrack(snap(["a", "b", "c"], 0, [0, 2, 1], true), { upNextAt: 1, shufflePos: 2 }, 2);
        expect(next.shuffleIndices).toEqual([0, 1]);
        expect(next.shufflePos).toBe(1);
    });

    it("shifts the current index when an earlier track goes", () => {
        const next = removeTrack(snap(["a", "b", "c"], 2), cur, 0);
        expect(next.queue).toEqual(["b", "c"]);
        expect(next.currentIndex).toBe(1);
        expect(next.currentTrack).toBeUndefined();
    });

    it("keeps the current track when a later one goes", () => {
        const next = removeTrack(snap(["a", "b", "c"], 0), cur, 2);
        expect(next.currentIndex).toBe(0);
        expect(next.currentTrack).toBeUndefined();
    });

    it("moves to the following track when the current one goes", () => {
        const next = removeTrack(snap(["a", "b", "c"], 1), cur, 1);
        expect(next.currentIndex).toBe(1);
        expect(next.currentTrack).toBe("c");
    });

    it("wraps to the start when the last track was current", () => {
        const next = removeTrack(snap(["a", "b"], 1), cur, 1);
        expect(next.currentIndex).toBe(0);
        expect(next.currentTrack).toBe("a");
    });

    it("clears the track when the queue empties", () => {
        expect(removeTrack(snap(["a"], 0), cur, 0).currentTrack).toBeNull();
    });

    it("renumbers shuffle order", () => {
        expect(removeTrack(snap(["a", "b", "c"], 0, [2, 0, 1], true), cur, 1).shuffleIndices).toEqual([1, 0]);
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
