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
        expect(limit.take("a")).toBe(true);
        expect(limit.take("a")).toBe(true);
        expect(limit.take("a")).toBe(false);
        expect(limit.take("b")).toBe(true);
        now += WINDOW;
        expect(limit.take("a")).toBe(true);
    });

    it("gives a try back", () => {
        const limit = new GuessLimit(1, WINDOW);
        expect(limit.take("a")).toBe(true);
        limit.giveBack("a");
        expect(limit.take("a")).toBe(true);
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
        expect(limit.take("live")).toBe(false); // still counted
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
        expect(limit.take("fourth")).toBe(false); // newer counters kept
        expect(limit.take("third")).toBe(false);
        expect(limit.take("second")).toBe(false);
        expect(limit.take("first")).toBe(true); // forgotten, so it counts afresh
    });

    it("a subject whose window restarted counts as newer than one that began in between", () => {
        const limit = new GuessLimit(1, WINDOW, 2);
        limit.take("a");
        now += 1;
        limit.take("b");
        now += WINDOW; // both finished
        limit.take("a"); // a restarts, now the newest
        limit.take("c"); // full: finished b goes, not a
        expect(limit.take("a")).toBe(false);
    });

    it("keeps counting a subject that already has a counter even when full", () => {
        const limit = new GuessLimit(2, WINDOW, 2);
        limit.take("a");
        limit.take("b");
        expect(limit.take("a")).toBe(true);
        expect(limit.take("a")).toBe(false);
        expect(limit.size).toBe(2);
    });
});
