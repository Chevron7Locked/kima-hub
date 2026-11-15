/**
 * Fractional ranks for ordered lists: a move writes one row, and playlist
 * items and pending tracks share one key space. Keys are base-62 over an
 * ASCII-ordered alphabet, so plain string comparison and a btree order them.
 */

const ALPHABET =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = ALPHABET.length; // 62

/** Longest key we will generate before refusing; guards a pathological loop. */
const MAX_DEPTH = 64;

function digit(char: string): number {
    const i = ALPHABET.indexOf(char);
    if (i < 0) {
        throw new Error(`lexoRank: invalid character ${JSON.stringify(char)}`);
    }
    return i;
}

/**
 * A key strictly between `before` and `after`.
 *
 * Pass "" for `before` to mean "start of list" and "" for `after` to mean "end
 * of list". Requires `before < after` when both are given.
 */
export function rankBetween(before: string, after: string): string {
    if (before && after && before >= after) {
        throw new Error(
            `lexoRank: before must sort before after (got ${before} >= ${after})`
        );
    }

    let out = "";
    let i = 0;
    // Once a digit is below `after`'s at the same position, the upper bound no
    // longer constrains longer keys (e.g. ("AB", "B")).
    let upperOpen = after === "";

    for (;;) {
        const lo = i < before.length ? digit(before[i]) : 0;
        const hi = upperOpen ? BASE : i < after.length ? digit(after[i]) : 0;

        if (hi - lo > 1) {
            return out + ALPHABET[(lo + hi) >> 1];
        }

        out += ALPHABET[lo];
        if (!upperOpen && lo < hi) upperOpen = true;
        i += 1;

        if (i > MAX_DEPTH) {
            throw new Error(
                "lexoRank: exceeded max depth; the list needs rebalancing"
            );
        }
    }
}

/**
 * A key after everything in the list. Increments the last digit rather than
 * subdividing, so repeated appends keep the key length fixed.
 */
export function rankAfter(last: string | null | undefined): string {
    if (!last) return rankBetween("", "");
    const d = digit(last[last.length - 1]);
    if (d < BASE - 1) {
        return last.slice(0, -1) + ALPHABET[d + 1];
    }
    // Final digit is already the largest. Extend with the SMALLEST digit rather
    // than the midpoint: a longer string sharing this prefix already sorts after
    // `last`, so starting low leaves the whole next character available for the
    // following 61 appends instead of throwing away the lower half.
    if (last.length >= MAX_DEPTH) {
        throw new Error(
            "lexoRank: exceeded max depth; the list needs rebalancing"
        );
    }
    return last + ALPHABET[0];
}


/**
 * `count` evenly spread keys, for seeding a list in one shot.
 *
 * Spreading them keeps the keys short: appending one-at-a-time from the top of
 * the alphabet grows the string by a character each time, whereas an evenly
 * spread block stays single-character for lists up to 60 items.
 */
export function rankSequence(count: number): string[] {
    if (count <= 0) return [];
    if (count > BASE ** 2) {
        // Two characters cover 3844 positions; beyond that fall back to
        // chaining, which is still correct, just less compact.
        const out: string[] = [];
        let prev = "";
        for (let i = 0; i < count; i += 1) {
            prev = rankAfter(prev);
            out.push(prev);
        }
        return out;
    }

    const out: string[] = [];
    if (count <= BASE - 2) {
        // Single character, leaving room at both ends for later inserts.
        const step = Math.floor(BASE / (count + 1));
        for (let i = 1; i <= count; i += 1) {
            out.push(ALPHABET[Math.min(i * step, BASE - 1)]);
        }
        return out;
    }

    const span = BASE * BASE;
    const step = Math.floor(span / (count + 1));
    for (let i = 1; i <= count; i += 1) {
        const v = Math.min(i * step, span - 1);
        out.push(ALPHABET[Math.floor(v / BASE)] + ALPHABET[v % BASE]);
    }
    return out;
}

/**
 * `count` ascending keys strictly between `before` and `after` ("" for an open end). Splits the gap in the middle
 * and recurses, so the keys spread over it and grow by about a character for every 62-fold the run outgrows
 * the gap, not by one per key.
 */
export function ranksBetween(before: string, after: string, count: number): string[] {
    if (count <= 0) return [];
    const middle = count >> 1;
    const key = rankBetween(before, after);
    return [
        ...ranksBetween(before, key, middle),
        key,
        ...ranksBetween(key, after, count - middle - 1),
    ];
}

/**
 * A fixed-width (3-character, ~238k positions) rank for a zero-based
 * position, matching SQL `kima_rank_from_position`. For orderings known up
 * front; use rankSequence to seed and rankBetween/rankAfter for edits.
 */
export function rankForPosition(position: number): string {
    const v = Math.max(0, Math.floor(position)) + 1;
    return (
        ALPHABET[Math.floor(v / (BASE * BASE)) % BASE] +
        ALPHABET[Math.floor(v / BASE) % BASE] +
        ALPHABET[v % BASE]
    );
}
