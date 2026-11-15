/**
 * What a saved queue reads of a queue a web client sends: only the ids of its entries (the details stored are Kima's
 * own), the entries without an id are dropped, and the index follows its place through that.
 */
import { queueIdsOf, saveQueueOfIds } from "../savedQueue";

const song = (id: string) => ({ id, title: id });

describe("queueIdsOf", () => {
    it("reads only the id of each entry, in order, and nothing of what the client says the song is", () => {
        expect(queueIdsOf([{ id: "a", title: "stale", artist: { name: "Old" } }, { id: 7 }, song("b")], 0).ids).toEqual(["a", "7", "b"]);
    });

    it("drops the entries without an id", () => {
        expect(queueIdsOf([{ title: "no id" }, song("a"), null, "text", { id: "" }, song("b")], 0).ids).toEqual(["a", "b"]);
    });

    it("moves the index back by the entries dropped before it, and onto the next entry kept when its own was dropped", () => {
        expect(queueIdsOf([null, song("a"), { title: "x" }, song("b")], 3).clientIndex).toBe(1);
        expect(queueIdsOf([song("a"), { title: "x" }, song("b")], 1).clientIndex).toBe(1);
    });

    it("carries a whole index over as it is, and leaves one past the end for the plan to clamp", () => {
        expect(queueIdsOf([song("a")], 0).clientIndex).toBe(0);
        expect(queueIdsOf([song("a"), song("b")], 9).clientIndex).toBe(9);
    });

    it("gives no ids for no entries", () => {
        expect(queueIdsOf([], 5)).toEqual({ ids: [], clientIndex: 5 });
        expect(queueIdsOf([{ title: "x" }], 0)).toEqual({ ids: [], clientIndex: 0 });
    });
});

describe("saveQueueOfIds", () => {
    it.each([
        ["a negative index", { clientIndex: -1, position: 0 }],
        ["a fractional index", { clientIndex: 1.5, position: 0 }],
        ["an index that is no number", { clientIndex: Number.NaN, position: 0 }],
        ["a negative position", { clientIndex: 0, position: -1 }],
        ["a fractional position", { clientIndex: 0, position: 0.5 }],
    ])("takes only whole places and positions of 0 or more: %s is refused before the database is touched", async (_name, place) => {
        await expect(saveQueueOfIds("nobody", { ids: [], changedBy: "test", ...place })).rejects.toThrow(TypeError);
    });
});
