/**
 * What a saved queue keeps of a queue a client sends: the entries without an id are dropped before the queue is cut to
 * the limit, and the index follows its song through both.
 */
import { acceptQueue } from "../savedQueue";

const song = (id: string) => ({ id, title: id });
const ids = (accepted: ReturnType<typeof acceptQueue>) => accepted.queue?.map((e) => e.id);

describe("acceptQueue", () => {
    it("cuts to the limit after the entries without an id are dropped, so they do not use up the limit", () => {
        const accepted = acceptQueue([{ title: "no id" }, song("a"), song("b"), song("c")], 0, 2);

        expect(ids(accepted)).toEqual(["a", "b"]);
    });

    it("moves the index back by the entries dropped before it, and onto the next entry kept when its own was dropped", () => {
        expect(acceptQueue([null, song("a"), { title: "x" }, song("b")], 3, 10).currentIndex).toBe(1);
        expect(acceptQueue([song("a"), { title: "x" }, song("b")], 1, 10).currentIndex).toBe(1);
    });

    it("keeps the index inside the queue kept, and stores no queue and index 0 for none", () => {
        expect(acceptQueue([song("a"), song("b"), song("c")], 9, 2).currentIndex).toBe(1);
        expect(acceptQueue([song("a")], -4, 10).currentIndex).toBe(0);
        expect(acceptQueue([song("a")], "x", 10).currentIndex).toBe(0);
        expect(acceptQueue([], 5, 10)).toEqual({ queue: null, currentIndex: 0 });
        expect(acceptQueue([{ title: "x" }], 0, 10)).toEqual({ queue: null, currentIndex: 0 });
    });

    it("fills what a player draws with its limits", () => {
        const [entry] = acceptQueue([{ id: 7, title: "t".repeat(900), duration: "12", artist: { id: 1 }, album: { title: "al", coverArt: "c" } }], 0, 10).queue!;

        expect(entry).toEqual({
            id: "7",
            title: "t".repeat(500),
            displayTitle: null,
            duration: 12,
            artist: { id: "1", name: "Unknown" },
            album: { id: "", title: "al", coverArt: "c" },
        });
    });
});
