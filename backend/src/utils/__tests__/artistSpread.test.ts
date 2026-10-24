/**
 * The station order (spreadByArtist): every song kept, no artist twice in a row whenever that is possible, an artist
 * with more than half the songs in runs as short and even as possible, a big artist spread through the order, and a
 * fresh order each call that one seed repeats.
 */
import { randomFromSeed, spreadByArtist } from "../artistSpread";

interface Song {
    id: string;
    artist: string;
}

/** `[artist, songs]` pairs as songs, in artist order. */
const pool = (shape: [string, number][]): Song[] =>
    shape.flatMap(([artist, count]) => Array.from({ length: count }, (_, i) => ({ id: `${artist}#${i}`, artist })));
const spread = (songs: Song[], random?: () => number) => spreadByArtist(songs, (s) => s.artist, random);

function longestRun(order: Song[]): number {
    let run = 1;
    let longest = order.length > 0 ? 1 : 0;
    for (let i = 1; i < order.length; i++) {
        run = order[i].artist === order[i - 1].artist ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    return longest;
}

/** The lengths of the runs of `artist`, in order. */
function runsOf(order: Song[], artist: string): number[] {
    const runs: number[] = [];
    let run = 0;
    for (const song of order) {
        if (song.artist === artist) run++;
        else if (run > 0) {
            runs.push(run);
            run = 0;
        }
    }
    if (run > 0) runs.push(run);
    return runs;
}

/** A pool like Epic on the W8 testbed: one artist with 347 of 595 songs, 248 by 50 others. */
const EPIC = pool([["big", 347], ...Array.from({ length: 50 }, (_, i): [string, number] => [`o${i}`, i < 8 ? 10 : 4])]);
const sameSongs = (a: Song[], b: Song[]) => expect([...a].map((s) => s.id).sort()).toEqual([...b].map((s) => s.id).sort());

describe("spreadByArtist", () => {
    it("keeps every song exactly once, whatever the pool", () => {
        const random = randomFromSeed("keeps");
        for (let t = 0; t < 500; t++) {
            const artists = 1 + Math.floor(random() * 8);
            const shape = Array.from({ length: artists }, (_, a): [string, number] => [`a${a}`, 1 + Math.floor(random() * 30)]);
            const songs = pool(shape);
            const order = spread(songs, random);
            expect(order).toHaveLength(songs.length);
            sameSongs(order, songs);
        }
        expect(spread([])).toEqual([]);
        expect(spread(pool([["solo", 1]]))).toEqual(pool([["solo", 1]]));
    });

    it("never plays one artist twice in a row while the largest has at most one more song than all others", () => {
        const random = randomFromSeed("adjacent");
        let tight = 0;
        for (let t = 0; t < 3000; t++) {
            const artists = 2 + Math.floor(random() * 6);
            const shape = Array.from({ length: artists }, (_, a): [string, number] => [
                `a${a}`,
                1 + Math.floor(random() * (random() < 0.3 ? 40 : 8)),
            ]);
            const total = shape.reduce((sum, [, c]) => sum + c, 0);
            const largest = Math.max(...shape.map(([, c]) => c));
            if (2 * largest > total + 1) continue;
            if (2 * largest === total + 1) tight++;
            expect(longestRun(spread(pool(shape), random))).toBe(1);
        }
        // The edge case, where the largest artist must open and close the order, came up.
        expect(tight).toBeGreaterThan(10);
        expect(spread(pool([["a", 3], ["b", 2]])).map((s) => s.artist)).toEqual(["a", "b", "a", "b", "a"]);
    });

    it("splits an artist with more than half the songs into runs one apart in length, each other song alone between", () => {
        for (let t = 0; t < 50; t++) {
            const order = spread(EPIC);
            // 347 songs in 249 runs: 98 runs of 2 and 151 of 1, the shortest longest run there is.
            const runs = runsOf(order, "big");
            expect(runs).toHaveLength(249);
            expect(runs.filter((r) => r === 2)).toHaveLength(98);
            expect(runs.filter((r) => r === 1)).toHaveLength(151);
            expect(order[0].artist).toBe("big");
            expect(order[order.length - 1].artist).toBe("big");
            for (let i = 1; i < order.length; i++) {
                expect(order[i].artist === "big" || order[i - 1].artist === "big").toBe(true);
            }
        }
        expect(longestRun(spread(pool([["big", 10], ["x", 1], ["y", 1]])))).toBe(4);
        expect(spread(pool([["only", 4]])).map((s) => s.artist)).toEqual(["only", "only", "only", "only"]);
    });

    it("spaces the runs' longer ones evenly: in Epic's first 100 songs about 58 by the big artist, at most 12 in any 20", () => {
        for (let t = 0; t < 200; t++) {
            const order = spread(EPIC);
            const first = order.slice(0, 100).filter((s) => s.artist === "big").length;
            expect(first).toBeGreaterThanOrEqual(56);
            expect(first).toBeLessThanOrEqual(60);
            for (let i = 0; i + 20 <= order.length; i++) {
                expect(order.slice(i, i + 20).filter((s) => s.artist === "big").length).toBeLessThanOrEqual(12);
            }
        }
    });

    it("spreads a big artist under half through the whole order, not only apart from itself", () => {
        // 120 of 600 songs (20%): 4 in every 20 give or take one, in any 20 in a row. (Sorting every artist on one
        // line, as Spotify's write-up does, gave up to 7.)
        const songs = pool([["big", 120], ...Array.from({ length: 80 }, (_, i): [string, number] => [`o${i}`, 6])]);
        for (let t = 0; t < 100; t++) {
            const order = spread(songs);
            expect(longestRun(order)).toBe(1);
            for (let i = 0; i + 20 <= order.length; i++) {
                const count = order.slice(i, i + 20).filter((s) => s.artist === "big").length;
                expect(count).toBeGreaterThanOrEqual(3);
                expect(count).toBeLessThanOrEqual(5);
            }
        }
    });

    it("gives a fresh order each call, any song can come first, and one seed repeats its order", () => {
        const songs = pool([["a", 5], ["b", 4], ["c", 3], ["d", 1]]);
        const orders = new Set<string>();
        const first = new Map<string, number>();
        for (let t = 0; t < 4000; t++) {
            const order = spread(songs);
            orders.add(order.map((s) => s.id).join(","));
            first.set(order[0].id, (first.get(order[0].id) ?? 0) + 1);
        }
        expect(orders.size).toBeGreaterThan(3000);
        expect(first.size).toBe(songs.length);
        // Each of an artist's songs leads as often as its other songs: a's 5 within a factor of 2 of each other.
        const leadsOfA = songs.filter((s) => s.artist === "a").map((s) => first.get(s.id) ?? 0);
        expect(Math.max(...leadsOfA)).toBeLessThan(2 * Math.min(...leadsOfA));

        const seeded = (seed: string) => spread(EPIC, randomFromSeed(seed)).map((s) => s.id);
        expect(seeded("one")).toEqual(seeded("one"));
        expect(seeded("one")).not.toEqual(seeded("two"));
    });

    it("orders 500,000 songs in a few seconds at most", () => {
        const songs = pool([["big", 200_000], ...Array.from({ length: 30_000 }, (_, i): [string, number] => [`o${i}`, 10])]);
        const started = Date.now();
        const order = spread(songs);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(order).toHaveLength(500_000);
        expect(longestRun(order)).toBe(1);
    });
});

describe("randomFromSeed", () => {
    it("repeats one seed's numbers, differs between seeds, and stays in [0, 1)", () => {
        const take = (seed: string) => {
            const random = randomFromSeed(seed);
            return Array.from({ length: 1000 }, () => random());
        };
        const a = take("a");
        expect(take("a")).toEqual(a);
        expect(take("b")).not.toEqual(a);
        expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
        expect(a.reduce((s, x) => s + x, 0) / a.length).toBeCloseTo(0.5, 1);
    });
});
