/**
 * One key space, two generators.
 *
 * `rankSequence` (used to seed an empty playlist) emits 1-character keys;
 * `rankForPosition` (used to seed a playlist from an ordered import, and by the
 * SQL backfill's kima_rank_from_position) emits fixed 3-character keys. Both are
 * fine on their own. Mixing them is not: '0' (0x30) sorts before every letter
 * and digit `rankSequence` uses, so appending position-derived keys to a
 * natively-seeded playlist put the whole batch AHEAD of everything already
 * there, silently.
 *
 * That is why appends go through playlistService.allocateAppendRanks, which
 * chains from the list's existing last rank with `rankAfter` and so preserves
 * whatever width is already in use. These lock the property that made the bug
 * possible, so it cannot be reintroduced by "just deriving the rank".
 */

import { rankAfter, rankForPosition, rankSequence } from "../lexoRank";

describe("rank width", () => {
    it("rankSequence and rankForPosition are NOT comparable — the bug's root", () => {
        const native = rankSequence(3); // what an empty playlist gets
        const derived = rankForPosition(3); // what a position-derived append gave

        // Every position-derived key sorts before every natively-seeded one.
        for (const n of native) {
            expect(derived < n).toBe(true);
        }
    });

    it("rankAfter preserves width, so chaining stays in the same space", () => {
        for (const seed of [rankSequence(1)[0], rankForPosition(0), rankForPosition(999)]) {
            const next = rankAfter(seed);
            expect(next.length).toBe(seed.length);
            expect(next > seed).toBe(true);
        }
    });

    it("chaining from the last rank always appends, whichever generator seeded it", () => {
        for (const seeded of [rankSequence(4), [0, 1, 2, 3].map(rankForPosition)]) {
            const last = seeded[seeded.length - 1];
            let prev = last;
            const appended: string[] = [];
            for (let i = 0; i < 3; i += 1) {
                prev = rankAfter(prev);
                appended.push(prev);
            }
            // every appended key sorts after every existing key
            for (const a of appended) {
                for (const s of seeded) expect(a > s).toBe(true);
            }
            // and they stay in order among themselves
            expect([...appended].sort()).toEqual(appended);
        }
    });
});
