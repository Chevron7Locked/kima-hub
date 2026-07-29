/**
 * Fractional lexicographic ranks for ordered lists.
 *
 * Playlist order used an integer `sort` column, which meant a reorder rewrote
 * every row (one UPDATE each, inside one transaction) and, because nothing
 * enforced uniqueness, concurrent writes produced duplicate positions that
 * Postgres then returned in arbitrary order. Worse, `PlaylistItem.sort` and
 * `PlaylistPendingTrack.sort` were two independent counters that the read path
 * merged by comparing them to each other -- so a single reorder renumbered
 * items to 0..n-1 and collided head-on with the pending tracks' original
 * Spotify positions, scrambling any imported playlist.
 *
 * A fractional rank fixes both: moving one row writes exactly one row, and both
 * tables can draw from ONE key space so merging them by rank is meaningful.
 *
 * Keys are base-62 strings over an ASCII-ordered alphabet, so a plain string
 * comparison (and a plain btree index) orders them correctly -- no numeric
 * decoding anywhere.
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
    // Once we commit a digit strictly below `after`'s digit at the same
    // position, every longer key with this prefix is already below `after`, so
    // the upper bound stops constraining us. Without this the walk breaks on
    // pairs like ("AB", "B"), where `after` runs out of digits while `before`
    // still has some.
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
 * A key that sorts after everything currently in the list.
 *
 * Increments the final digit rather than subdividing the space above `last`.
 * Subdividing halves the remaining gap every time, so the key grew by a
 * character roughly every six appends and a few hundred appends blew the depth
 * limit -- and appending is the common operation (adding a track to the end).
 * Incrementing keeps the length fixed until the final digit tops out.
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
 * A key that sorts before everything currently in the list.
 *
 * Steps the leading digit down while there is room. Note the asymmetry with
 * `rankAfter`: nothing sorts below a key of all-zeroes, so unbounded prepending
 * eventually has to subdivide and the keys do grow. That is inherent to
 * fractional indexing, not a defect here -- prepending is rare, and the list
 * can be re-seeded with `rankSequence` if it ever becomes a problem.
 */
export function rankBefore(first: string | null | undefined): string {
    if (!first) return rankBetween("", "");
    const d = digit(first[0]);
    if (first.length === 1 && d > 1) {
        // Halve the space below rather than stepping by one, so repeated
        // prepends stay short for longer.
        return ALPHABET[d >> 1];
    }
    return rankBetween("", first);
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
 * A fixed-width rank for a known zero-based position.
 *
 * Mirrors the `kima_rank_from_position` function in the playlist-rank migration,
 * character for character, so ranks written by an import land on the SAME scale
 * as ranks backfilled by that migration. Three characters keep every key the
 * same length, which makes string ordering match numeric ordering without any
 * padding logic at read time, and cover 238k positions.
 *
 * Use this when the whole ordering is known up front (an import). Use
 * `rankSequence` when seeding a fresh list and `rankBetween`/`rankAfter` for
 * incremental changes.
 */
export function rankForPosition(position: number): string {
    const v = Math.max(0, Math.floor(position)) + 1;
    return (
        ALPHABET[Math.floor(v / (BASE * BASE)) % BASE] +
        ALPHABET[Math.floor(v / BASE) % BASE] +
        ALPHABET[v % BASE]
    );
}
