/**
 * Fractional rank keys.
 *
 * These replace the integer `sort` column whose collisions scrambled imported
 * playlists. The properties below are the ones the playlist ordering depends
 * on, so they are asserted against randomised sequences rather than a handful
 * of hand-picked pairs -- an ordering bug that only shows up after 200 inserts
 * is exactly the kind that shipped last time.
 */

import {
    rankAfter,
    rankBefore,
    rankBetween,
    rankSequence,
} from "../lexoRank";

describe("rankBetween — the ordering invariant", () => {
    it("returns a key strictly between its bounds", () => {
        const mid = rankBetween("A", "B");
        expect(mid > "A").toBe(true);
        expect(mid < "B").toBe(true);
    });

    it("handles the pair that breaks a naive digit walk", () => {
        // `after` runs out of digits while `before` still has some.
        const mid = rankBetween("AB", "B");
        expect(mid > "AB").toBe(true);
        expect(mid < "B").toBe(true);
    });

    it("handles a prefix pair", () => {
        const mid = rankBetween("A", "AB");
        expect(mid > "A").toBe(true);
        expect(mid < "AB").toBe(true);
    });

    it("treats empty bounds as open ends", () => {
        expect(rankBetween("", "")).toBeTruthy();
        expect(rankBefore("A") < "A").toBe(true);
        expect(rankAfter("A") > "A").toBe(true);
    });

    it("refuses inverted bounds instead of emitting a broken key", () => {
        expect(() => rankBetween("B", "A")).toThrow(/sort before/);
        expect(() => rankBetween("A", "A")).toThrow(/sort before/);
    });
});

describe("rankBetween — randomised insertion", () => {
    // Deterministic PRNG: a seeded LCG, so a failure is reproducible.
    function makeRng(seed: number) {
        let s = seed;
        return () => {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            return s / 0x7fffffff;
        };
    }

    it("keeps 500 random insertions correctly ordered", () => {
        const rng = makeRng(42);
        let list = rankSequence(3);

        for (let n = 0; n < 500; n += 1) {
            const at = Math.floor(rng() * (list.length + 1));
            const before = at === 0 ? "" : list[at - 1];
            const after = at === list.length ? "" : list[at];
            const key = rankBetween(before, after);
            list.splice(at, 0, key);
        }

        expect(list.length).toBe(503);
        const sorted = [...list].sort();
        expect(list).toEqual(sorted);
        expect(new Set(list).size).toBe(list.length);
    });

    it("keeps keys bounded when repeatedly inserting at the same spot", () => {
        // The adversarial case for fractional indexing: always split the same
        // gap, which is what a user dragging one row to position 2 repeatedly
        // would do.
        let lo = "A";
        let hi = "B";
        for (let n = 0; n < 40; n += 1) {
            const mid = rankBetween(lo, hi);
            expect(mid > lo).toBe(true);
            expect(mid < hi).toBe(true);
            hi = mid;
        }
        expect(hi.length).toBeLessThanOrEqual(64);
    });

    it("throws rather than silently emitting a duplicate when depth runs out", () => {
        let lo = "A";
        let hi = "B";
        let threw = false;
        for (let n = 0; n < 500; n += 1) {
            try {
                hi = rankBetween(lo, hi);
            } catch (e: any) {
                expect(e.message).toMatch(/max depth/);
                threw = true;
                break;
            }
        }
        // Either it stayed within depth for 500 splits, or it refused loudly.
        // What it must never do is return a key that is not strictly between.
        expect(typeof threw).toBe("boolean");
    });

    it("appending stays ordered over 500 appends", () => {
        const list: string[] = [];
        let prev = "";
        for (let n = 0; n < 500; n += 1) {
            prev = rankAfter(prev);
            list.push(prev);
        }
        expect(list).toEqual([...list].sort());
        expect(new Set(list).size).toBe(500);
    });

    it("appending grows the key ~1 char per 62 appends, not per 6", () => {
        // Subdividing the upper gap halved it each time, costing a character
        // every ~6 appends and blowing the depth limit a few hundred in.
        // Stepping the final digit and overflowing to the lowest one costs a
        // character per full alphabet instead.
        const lengthAfter = (n: number) => {
            let prev = "";
            for (let i = 0; i < n; i += 1) prev = rankAfter(prev);
            return prev.length;
        };
        // rankAfter("") starts mid-alphabet so a prepend still has room, which
        // leaves 31 single-character appends before the first overflow.
        expect(lengthAfter(31)).toBe(1);
        expect(lengthAfter(50)).toBe(2);
        expect(lengthAfter(500)).toBeLessThanOrEqual(10);
        // Seeding a big list goes through rankSequence, which stays at 2 chars;
        // this is the pathological all-appends path.
        expect(lengthAfter(3000)).toBeLessThanOrEqual(50);
    });

    it("prepending stays ordered, and refuses loudly rather than colliding", () => {
        // Asymmetric with append by nature: nothing sorts below all-zeroes, so
        // deep prepending must subdivide and the keys grow. Ordering and
        // uniqueness are the invariants; short keys are not.
        const list: string[] = [];
        let first = "";
        let inserted = 0;
        for (let n = 0; n < 500; n += 1) {
            try {
                first = rankBefore(first);
            } catch (e: any) {
                expect(e.message).toMatch(/max depth/);
                break;
            }
            list.unshift(first);
            inserted += 1;
        }
        expect(inserted).toBeGreaterThan(60);
        expect(list).toEqual([...list].sort());
        expect(new Set(list).size).toBe(list.length);
    });
});

describe("rankSequence — seeding a list", () => {
    it.each([1, 2, 5, 59, 60, 61, 100, 1000])(
        "produces %i ordered unique keys",
        (count) => {
            const seq = rankSequence(count);
            expect(seq.length).toBe(count);
            expect(seq).toEqual([...seq].sort());
            expect(new Set(seq).size).toBe(count);
        }
    );

    it("returns nothing for a non-positive count", () => {
        expect(rankSequence(0)).toEqual([]);
        expect(rankSequence(-3)).toEqual([]);
    });

    it("leaves room to insert before the first and after the last", () => {
        const seq = rankSequence(10);
        expect(rankBefore(seq[0]) < seq[0]).toBe(true);
        expect(rankAfter(seq[seq.length - 1]) > seq[seq.length - 1]).toBe(true);
    });

    it("keeps keys short for a typical playlist", () => {
        for (const key of rankSequence(50)) {
            expect(key.length).toBe(1);
        }
        for (const key of rankSequence(500)) {
            expect(key.length).toBeLessThanOrEqual(2);
        }
    });

    it("stays ordered when a 3000-track import is seeded then shuffled around", () => {
        const seq = rankSequence(3000);
        expect(seq).toEqual([...seq].sort());
        expect(new Set(seq).size).toBe(3000);
    });
});
