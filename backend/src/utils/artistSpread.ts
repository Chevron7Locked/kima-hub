import crypto from "crypto";

/**
 * A random play order that spreads each artist's songs through the whole order, so a station whose pool is mostly one
 * artist does not play them in long runs. Every item is kept; only the order is chosen.
 *
 * 1. Spread, after Spotify's shuffle (Poláček 2014, "How to shuffle songs?", engineering.atspotify.com, itself after
 *    Fiedler's "Balanced Shuffle", keyj.emphy.de/balanced-shuffle): an artist with c songs gets them in a random order,
 *    about 1/c of the way apart, each gap varying from 0.8 to 1.2 of that, from a random offset in the first gap.
 *    Spotify places every artist on one line and sorts; then where the others happen to bunch, a big artist's songs
 *    bunch too (7 of 20 in a row for an artist with 20% of the songs). Here the artists take places in the order
 *    itself instead, largest first, each spread evenly over the places still free.
 * 2. Repair: two songs of one artist can still land side by side. The order is rebuilt from those places, taking the
 *    earliest song whose artist is not the one just played. Songs can be ordered with no artist
 *    twice in a row exactly when the largest artist has at most one more song than all the others together (each
 *    pair of its songs needs another song between them); while that holds the rebuild keeps it, playing that artist
 *    first whenever it has exactly one more song than the others left.
 * 3. When one artist has more songs than that, runs of it cannot be avoided. Each other song stands alone between
 *    runs of the big artist, and those runs differ in length by at most one, the longer ones spaced evenly from a
 *    random start: the shortest longest run possible.
 *
 * Cost: O(n log n), from a tree over the free places and a heap over the artists; `random` is called about twice per
 * item.
 */
export function spreadByArtist<T>(items: readonly T[], artistOf: (item: T) => string, random: () => number = Math.random): T[] {
    const n = items.length;
    if (n < 2) return [...items];

    const byArtist = new Map<string, T[]>();
    for (const item of items) {
        const artist = artistOf(item);
        const songs = byArtist.get(artist);
        if (songs) songs.push(item);
        else byArtist.set(artist, [item]);
    }

    // Step 1. Largest artist first (ties in random order), each artist's songs shuffled and spread over the free places.
    const artists = [...byArtist.values()];
    shuffleInPlace(artists, random);
    artists.sort((a, b) => b.length - a.length);
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
    if (2 * big > n + 1) return runsOfMajority(placed, largest, big, n - big, random);
    return withoutRepeats(placed, queues);
}

/** Step 2: the spread order with no artist twice in a row; the caller has checked that one exists. */
function withoutRepeats<T>(placed: { artist: number; item: T }[], queues: number[][]): T[] {
    const heads = queues.map(() => 0);
    const remaining = queues.map((q) => q.length);
    // Artists by how many songs they have left, to find one that must play next.
    const withCount = new Map<number, Set<number>>();
    let most = 0;
    remaining.forEach((count, artist) => {
        if (!withCount.has(count)) withCount.set(count, new Set());
        withCount.get(count)!.add(artist);
        most = Math.max(most, count);
    });
    // Each artist's next song by its place in the spread order. An entry whose rank is no longer its artist's next
    // song is stale and skipped.
    const heap = new MinHeap();
    queues.forEach((q, artist) => heap.push(q[0], artist));

    const order: T[] = [];
    let previous = -1;
    for (let left = placed.length; left > 0; left--) {
        let artist: number;
        if (2 * most === left + 1) {
            // This artist has one more song than all the others left: it plays now, or two of its songs would meet.
            artist = withCount.get(most)!.values().next().value!;
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
        withCount.get(count)!.delete(artist);
        if (!withCount.has(count - 1)) withCount.set(count - 1, new Set());
        withCount.get(count - 1)!.add(artist);
        while (most > 0 && withCount.get(most)!.size === 0) most--;
        if (heads[artist] < queues[artist].length) heap.push(queues[artist][heads[artist]], artist);
        previous = artist;
    }
    return order;
}

function popCurrent(heap: MinHeap, queues: number[][], heads: number[]): { rank: number; artist: number } {
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
 * the runs are one song longer, at evenly spaced places from a random start. Both sets keep their spread order.
 */
function runsOfMajority<T>(placed: { artist: number; item: T }[], largest: number, big: number, others: number, random: () => number): T[] {
    const mine = placed.filter((p) => p.artist === largest).map((p) => p.item);
    const theirs = placed.filter((p) => p.artist !== largest).map((p) => p.item);
    const runs = others + 1;
    const short = Math.floor(big / runs);
    const longer = big % runs;
    const phase = random();
    const order: T[] = [];
    let next = 0;
    for (let run = 0; run < runs; run++) {
        const long = Math.floor(((run + 1) * longer) / runs + phase) - Math.floor((run * longer) / runs + phase);
        const length = short + long;
        for (let i = 0; i < length; i++) order.push(mine[next++]);
        if (run < others) order.push(theirs[run]);
    }
    return order;
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
 * Numbers in [0, 1) that one seed always repeats, so a station can hand out one order a page at a time: SHA-256 of the
 * seed and a counter, read 32 bits at a time.
 */
export function randomFromSeed(seed: string): () => number {
    let block = Buffer.alloc(0);
    let used = 0;
    let counter = 0;
    return () => {
        if (used === block.length) {
            block = crypto.createHash("sha256").update(`${seed}\0${counter++}`).digest();
            used = 0;
        }
        const value = block.readUInt32BE(used) / 4294967296;
        used += 4;
        return value;
    };
}
