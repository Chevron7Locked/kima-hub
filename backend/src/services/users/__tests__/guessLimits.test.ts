/**
 * GuessLimit at its interface: the count per subject, and the bound on how many subjects it remembers. Time is faked by
 * moving Date.now, so no test waits.
 */

import { GuessLimit } from "../guessLimits";

const WINDOW = 1000;
let now = 0;

beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

describe("counting", () => {
    it("allows max tries then refuses, and starts over when the window ends", () => {
        const limit = new GuessLimit(2, WINDOW);
        expect(limit.take("a")).not.toBeNull();
        expect(limit.take("a")).not.toBeNull();
        expect(limit.take("a")).toBeNull();
        expect(limit.take("b")).not.toBeNull();
        now += WINDOW;
        expect(limit.take("a")).not.toBeNull();
    });

    it("gives a try back", () => {
        const limit = new GuessLimit(1, WINDOW);
        const attempt = limit.take("a");
        expect(attempt).not.toBeNull();
        limit.giveBack(attempt!);
        expect(limit.take("a")).not.toBeNull();
    });

    it("gives back only the try that was taken: not a newer window's, nor a re-made counter's", () => {
        const limit = new GuessLimit(2, WINDOW);

        // The window rolls over while the password is being checked.
        const slow = limit.take("a")!;
        now += WINDOW;
        expect(limit.take("a")).not.toBeNull(); // new window, 1 of 2
        limit.giveBack(slow);
        expect(limit.take("a")).not.toBeNull(); // 2 of 2: the refund did not lower it
        expect(limit.take("a")).toBeNull();
    });

    it("gives nothing back after the counter was evicted and the subject began again", () => {
        const limit = new GuessLimit(2, WINDOW, 2);
        const slow = limit.take("a")!;
        now += 1;
        limit.take("b");
        now += 1;
        limit.take("c"); // full: a, the oldest live counter, is dropped
        expect(limit.take("a")).not.toBeNull(); // a begins again (1 of 2); b is dropped
        limit.giveBack(slow);
        expect(limit.take("a")).not.toBeNull(); // 2 of 2
        expect(limit.take("a")).toBeNull();
    });

    it("gives back nothing for a counter whose window has ended", () => {
        const limit = new GuessLimit(1, WINDOW);
        const old = limit.take("a")!;
        now += WINDOW;
        limit.giveBack(old);
        expect(limit.take("a")).not.toBeNull();
        expect(limit.take("a")).toBeNull();
    });

    it("gives a try back only once", () => {
        const limit = new GuessLimit(2, WINDOW);
        const first = limit.take("a")!;
        limit.take("a");
        limit.giveBack(first);
        limit.giveBack(first);
        expect(limit.take("a")).not.toBeNull(); // 2 of 2
        expect(limit.take("a")).toBeNull();
    });
});

describe("the bound", () => {
    it("never holds more subjects than the cap, however many random names arrive", () => {
        const limit = new GuessLimit(2, WINDOW, 5);
        for (let i = 0; i < 100; i++) limit.take(`name-${i}`);
        expect(limit.size).toBe(5);
    });

    it("drops finished counters before any live one", () => {
        const limit = new GuessLimit(1, WINDOW, 3);
        limit.take("old-1");
        limit.take("old-2");
        now += WINDOW - 1;
        limit.take("live"); // the cap is reached
        now += 1; // old-1 and old-2 are finished, live is not
        limit.take("new");
        expect(limit.size).toBe(2);
        expect(limit.take("live")).toBeNull(); // still counted
    });

    it("when every counter is live and the cap is reached, drops the oldest", () => {
        const limit = new GuessLimit(1, WINDOW, 3);
        limit.take("first");
        now += 1;
        limit.take("second");
        now += 1;
        limit.take("third");
        now += 1;
        limit.take("fourth");
        expect(limit.size).toBe(3);
        expect(limit.take("fourth")).toBeNull(); // newer counters kept
        expect(limit.take("third")).toBeNull();
        expect(limit.take("second")).toBeNull();
        expect(limit.take("first")).not.toBeNull(); // forgotten, so it counts afresh
    });

    it("a subject whose window restarted counts as newer than one that began in between", () => {
        const limit = new GuessLimit(1, WINDOW, 2);
        limit.take("a");
        now += 1;
        limit.take("b");
        now += WINDOW; // both finished
        limit.take("a"); // a restarts, now the newest
        limit.take("c"); // full: finished b goes, not a
        expect(limit.take("a")).toBeNull();
    });

    it("keeps counting a subject that already has a counter even when full", () => {
        const limit = new GuessLimit(2, WINDOW, 2);
        limit.take("a");
        limit.take("b");
        expect(limit.take("a")).not.toBeNull();
        expect(limit.take("a")).toBeNull();
        expect(limit.size).toBe(2);
    });
});
