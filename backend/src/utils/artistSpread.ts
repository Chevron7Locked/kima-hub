import crypto from "crypto";

/**
 * A random play order that spreads each artist's songs through the whole order, so a station whose pool is mostly one
 * artist does not play them in long runs. Every item is kept; only the order is chosen.
 *
 * 1. Spread, after Spotify's balanced shuffle: an artist with c songs gets them in a random order, about 1/c of the
 *    way apart, each gap varying from 0.8 to 1.2 of that, from a random offset in the first gap. Unlike Spotify's one
 *    sorted line (where others bunch, a big artist bunches too), artists take places in the order itself, largest
 *    first, each spread evenly over the places still free.
 * 2. Repair: two songs of one artist can still land side by side. The order is rebuilt from those places, taking the
 *    earliest song whose artist is not the one just played. Songs can be ordered with no artist
 *    twice in a row exactly when the largest artist has at most one more song than all the others together (each
 *    pair of its songs needs another song between them); while that holds the rebuild keeps it, playing that artist
 *    first whenever it has exactly one more song than the others left.
 * 3. When one artist has more songs than that, runs of it cannot be avoided. Each other song stands alone between
 *    runs of the big artist, and those runs differ in length by at most one, the longer ones spaced evenly from a
 *    random start: the shortest longest run possible.
 *
 * 4. `follows` continues an order that came before (a station starting its pool over): the first song is not by the
 *    artist just played, where that is possible, and the songs heard last stay out of the first places (keepRecentLate).
 *
 * Cost: O(n log n), from a tree over the free places and a heap over the artists; `random` is called about twice per
 * item.
 */
export function spreadByArtist<T>(
    items: readonly T[],
    artistOf: (item: T) => string,
    random: () => number = Math.random,
    follows: Follows<T> = {},
): T[] {
    const n = items.length;
    if (n < 2) return [...items];
    const order = spreadOnce(items, artistOf, random, follows.previousArtist);
    return follows.recent ? keepRecentLate(order, artistOf, follows, random) : order;
}

/** What came before an order (spreadByArtist step 4). */
export type Follows<T> = {
    /** The artist of the song played just before the order. */
    previousArtist?: string;
} & (
    | { recent?: undefined; window?: undefined }
    /** The songs heard just before the order, kept out of its first `window` places. */
    | { recent: (item: T) => boolean; window: number }
);

function spreadOnce<T>(items: readonly T[], artistOf: (item: T) => string, random: () => number, previousArtist?: string): T[] {
    const n = items.length;

    const byArtist = new Map<string, T[]>();
    for (const item of items) {
        const artist = artistOf(item);
        const songs = byArtist.get(artist);
        if (songs) songs.push(item);
        else byArtist.set(artist, [item]);
    }

    // Step 1. Largest artist first (ties in random order), each artist's songs shuffled and spread over the free places.
    const names = [...byArtist.keys()];
    shuffleInPlace(names, random);
    names.sort((a, b) => byArtist.get(b)!.length - byArtist.get(a)!.length);
    const artists = names.map((name) => byArtist.get(name)!);
    const previous = previousArtist === undefined ? -1 : names.indexOf(previousArtist);
    const placed: { artist: number; item: T }[] = new Array(n);
    const free = new FreePlaces(n);
    artists.forEach((songs, artist) => {
        shuffleInPlace(songs, random);
        const c = songs.length;
        const gap = free.count / c;
        // Indexes into the free places, rising, with room left after each for the songs still to come.
        const at = new Array<number>(c);
        const offset = random() * gap;
        for (let j = 0; j < c; j++) {
            const target = Math.floor(offset + j * gap + (random() - 0.5) * 0.2 * gap);
            at[j] = Math.min(Math.max(target, j === 0 ? 0 : at[j - 1] + 1), free.count - (c - j));
        }
        // Last first, so taking a place does not move the free places before it.
        for (let j = c - 1; j >= 0; j--) placed[free.take(at[j])] = { artist, item: songs[j] };
    });

    // Each artist's songs in spread order, as indexes into `placed`.
    const queues: number[][] = artists.map(() => []);
    placed.forEach((p, rank) => queues[p.artist].push(rank));

    let largest = 0;
    for (let a = 1; a < queues.length; a++) if (queues[a].length > queues[largest].length) largest = a;
    const big = queues[largest].length;
    if (2 * big > n + 1) return runsOfMajority(placed, largest, big, n - big, random, previous === largest);
    return withoutRepeats(placed, queues, previous);
}

/**
 * Step 2: the spread order with no artist twice in a row; the caller has checked that one exists. `previous` is the
 * artist played just before the order (-1 for none); it does not open the order unless it must: with exactly one song
 * more than all the others, it has to come first and last.
 */
function withoutRepeats<T>(placed: { artist: number; item: T }[], queues: number[][], previous: number): T[] {
    const heads = new Int32Array(queues.length);
    const remaining = Int32Array.from(queues, (q) => q.length);
    // How many artists have each count of songs left, for the most any artist has left; and the artist that has it,
    // looked up again only when it no longer does.
    let most = 0;
    for (const count of remaining) most = Math.max(most, count);
    const withCount = new Int32Array(most + 1);
    for (const count of remaining) withCount[count]++;
    let leader = remaining.indexOf(most);
    // Each artist's next song by its place in the spread order. An entry whose rank is no longer its artist's next
    // song is stale and skipped.
    const heap = new MinHeap();
    queues.forEach((q, artist) => heap.push(q[0], artist));

    const order: T[] = [];
    for (let left = placed.length; left > 0; left--) {
        let artist: number;
        if (2 * most === left + 1) {
            // This artist has one more song than all the others left: it plays now, or two of its songs would meet.
            if (remaining[leader] !== most) leader = remaining.indexOf(most);
            artist = leader;
        } else {
            let top = popCurrent(heap, queues, heads);
            if (top.artist === previous) {
                const next = popCurrent(heap, queues, heads);
                heap.push(top.rank, top.artist);
                top = next;
            }
            artist = top.artist;
        }
        order.push(placed[queues[artist][heads[artist]]].item);
        heads[artist]++;
        const count = remaining[artist]--;
        withCount[count]--;
        withCount[count - 1]++;
        while (most > 0 && withCount[most] === 0) most--;
        if (heads[artist] < queues[artist].length) heap.push(queues[artist][heads[artist]], artist);
        previous = artist;
    }
    return order;
}

function popCurrent(heap: MinHeap, queues: number[][], heads: Int32Array): { rank: number; artist: number } {
    for (;;) {
        const entry = heap.pop();
        if (!entry) throw new Error("spreadByArtist: no song left to play");
        if (heads[entry.artist] < queues[entry.artist].length && queues[entry.artist][heads[entry.artist]] === entry.rank) {
            return entry;
        }
    }
}

/**
 * Step 3: the big artist's `big` songs in `others + 1` runs, each other song alone between two runs. `big % runs` of
 * the runs are one song longer, at evenly spaced places from a random start. Both sets keep their spread order. When
 * the big artist was just played (`openWithOther`), the order opens with another song instead, in `others` runs, so
 * its last run and the next first run do not meet; with no other song there is nothing to open with.
 */
function runsOfMajority<T>(
    placed: { artist: number; item: T }[],
    largest: number,
    big: number,
    others: number,
    random: () => number,
    openWithOther: boolean,
): T[] {
    const mine = placed.filter((p) => p.artist === largest).map((p) => p.item);
    const theirs = placed.filter((p) => p.artist !== largest).map((p) => p.item);
    const lead = openWithOther && others > 0;
    const runs = lead ? others : others + 1;
    const short = Math.floor(big / runs);
    const longer = big % runs;
    const phase = random();
    const order: T[] = [];
    let next = 0;
    let other = 0;
    for (let run = 0; run < runs; run++) {
        if (lead) order.push(theirs[other++]);
        const long = Math.floor(((run + 1) * longer) / runs + phase) - Math.floor((run * longer) / runs + phase);
        const length = short + long;
        for (let i = 0; i < length; i++) order.push(mine[next++]);
        if (!lead && run < others) order.push(theirs[other++]);
    }
    return order;
}

/**
 * Step 4: the songs `follows.recent` names out of the first `window` places (at most half the order), changing which
 * song takes which place but never which artist plays where, so steps 1-3 hold. First each artist's recent songs take
 * its latest places. An artist still left with a recent song early then trades all its places with an artist of as
 * many songs and none of them recent, chosen at random, whose latest places are late enough; a trade never puts the
 * artist just played first. Where no such artist exists (a small pool) the song stays early.
 */
function keepRecentLate<T>(order: T[], artistOf: (item: T) => string, follows: Follows<T>, random: () => number): T[] {
    const isRecent = follows.recent!;
    const window = Math.min(follows.window!, Math.floor(order.length / 2));
    const places = new Map<string, number[]>();
    const songs = new Map<string, T[]>();
    order.forEach((item, i) => {
        const artist = artistOf(item);
        if (!places.has(artist)) {
            places.set(artist, []);
            songs.set(artist, []);
        }
        places.get(artist)!.push(i);
        songs.get(artist)!.push(item);
    });
    const recentOf = new Map<string, number>();
    for (const [artist, list] of songs) {
        const recent = list.filter(isRecent);
        if (recent.length === 0) continue;
        recentOf.set(artist, recent.length);
        songs.set(artist, [...list.filter((s) => !isRecent(s)), ...recent]);
    }

    const spare = new Map<number, string[]>();
    for (const [artist, list] of places) {
        if (recentOf.has(artist)) continue;
        if (!spare.has(list.length)) spare.set(list.length, []);
        spare.get(list.length)!.push(artist);
    }
    for (const list of spare.values()) shuffleInPlace(list, random);
    const traded = new Set<string>();
    for (const [artist, recent] of recentOf) {
        const mine = places.get(artist)!;
        if (mine[mine.length - recent] >= window) continue;
        const candidates = spare.get(mine.length) ?? [];
        const i = candidates.findIndex((other) => {
            if (traded.has(other)) return false;
            const theirs = places.get(other)!;
            if (theirs[theirs.length - recent] < window) return false;
            if (theirs[0] === 0 && artist === follows.previousArtist) return false;
            if (mine[0] === 0 && other === follows.previousArtist) return false;
            return true;
        });
        if (i < 0) continue;
        const other = candidates[i];
        traded.add(other);
        places.set(artist, places.get(other)!);
        places.set(other, mine);
    }

    const out = new Array<T>(order.length);
    for (const [artist, list] of songs) list.forEach((song, k) => (out[places.get(artist)![k]] = song));
    return out;
}

function shuffleInPlace<T>(array: T[], random: () => number): void {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

/** Places 0..n-1, each free or taken; finds the k-th free place in O(log n) (a Fenwick tree of free counts). */
class FreePlaces {
    private tree: Int32Array;
    private top: number;
    count: number;

    constructor(private n: number) {
        this.tree = new Int32Array(n + 1);
        for (let i = 1; i <= n; i++) {
            this.tree[i] += 1;
            const parent = i + (i & -i);
            if (parent <= n) this.tree[parent] += this.tree[i];
        }
        this.top = 1;
        while (this.top * 2 <= n) this.top *= 2;
        this.count = n;
    }

    /** Takes the k-th free place (from 0) and returns it. */
    take(k: number): number {
        let at = 0;
        let left = k;
        for (let step = this.top; step > 0; step >>= 1) {
            const next = at + step;
            if (next <= this.n && this.tree[next] <= left) {
                at = next;
                left -= this.tree[next];
            }
        }
        for (let i = at + 1; i <= this.n; i += i & -i) this.tree[i] -= 1;
        this.count--;
        return at;
    }
}

/** A binary min-heap of (rank, artist) by rank. */
class MinHeap {
    private ranks: number[] = [];
    private artists: number[] = [];

    push(rank: number, artist: number): void {
        let i = this.ranks.length;
        this.ranks.push(rank);
        this.artists.push(artist);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.ranks[parent] <= rank) break;
            this.ranks[i] = this.ranks[parent];
            this.artists[i] = this.artists[parent];
            i = parent;
        }
        this.ranks[i] = rank;
        this.artists[i] = artist;
    }

    pop(): { rank: number; artist: number } | undefined {
        if (this.ranks.length === 0) return undefined;
        const top = { rank: this.ranks[0], artist: this.artists[0] };
        const rank = this.ranks.pop()!;
        const artist = this.artists.pop()!;
        const size = this.ranks.length;
        if (size > 0) {
            let i = 0;
            for (;;) {
                const left = 2 * i + 1;
                if (left >= size) break;
                const child = left + 1 < size && this.ranks[left + 1] < this.ranks[left] ? left + 1 : left;
                if (this.ranks[child] >= rank) break;
                this.ranks[i] = this.ranks[child];
                this.artists[i] = this.artists[child];
                i = child;
            }
            this.ranks[i] = rank;
            this.artists[i] = artist;
        }
        return top;
    }
}

/**
 * Numbers in [0, 1) that one seed always repeats, so a station can rebuild the same order: xoshiro128** (Blackman and
 * Vigna, prng.di.unimi.it) started from the SHA-256 of the seed. Hashing for every number cost about 0.3 s per 500,000
 * songs; this generator costs a few milliseconds.
 */
export function randomFromSeed(seed: string): () => number {
    const digest = crypto.createHash("sha256").update(seed).digest();
    let a = digest.readUInt32LE(0);
    let b = digest.readUInt32LE(4);
    let c = digest.readUInt32LE(8);
    let d = digest.readUInt32LE(12);
    if ((a | b | c | d) === 0) a = 1;
    return () => {
        const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
        const t = b << 9;
        c ^= a;
        d ^= b;
        b ^= c;
        a ^= d;
        c ^= t;
        d = rotl(d, 11);
        return result / 4294967296;
    };
}

function rotl(x: number, k: number): number {
    return (x << k) | (x >>> (32 - k));
}
