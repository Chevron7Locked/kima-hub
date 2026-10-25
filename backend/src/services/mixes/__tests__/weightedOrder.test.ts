/**
 * weightedOrder against the exact odds of a weighted draw without replacement (the Plackett-Luce model): the first pick
 * is song i with chance w_i / sum(w), the next is drawn from what is left the same way, and so on. Four songs of weights
 * 1, 2, 3 and 6 give 24 possible orders; 20,000 orders drawn from seeds "0" to "19999" must each come up as often as
 * its exact chance, within five standard deviations (the seeds are fixed, so the result is too).
 */
import { weightedOrder } from "../nightPlays";

const WEIGHTS: Record<string, number> = { a: 1, b: 2, c: 3, d: 6 };
const songs = Object.keys(WEIGHTS).map((id) => ({ id }));
const DRAWS = 20_000;

function chanceOf(order: string[]): number {
    let left = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    let chance = 1;
    for (const id of order) {
        chance *= WEIGHTS[id] / left;
        left -= WEIGHTS[id];
    }
    return chance;
}

function permutations(items: string[]): string[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));
}

describe("weightedOrder", () => {
    const counts = new Map<string, number>();
    beforeAll(() => {
        for (let i = 0; i < DRAWS; i++) {
            const key = weightedOrder(songs, (s) => WEIGHTS[s.id], String(i)).map((s) => s.id).join("");
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    });

    it("draws every one of the 24 orders as often as its exact chance", () => {
        const all = permutations(Object.keys(WEIGHTS));
        expect(all).toHaveLength(24);
        let total = 0;
        for (const order of all) {
            const p = chanceOf(order);
            const got = (counts.get(order.join("")) ?? 0) / DRAWS;
            total += p;
            expect(Math.abs(got - p)).toBeLessThan(5 * Math.sqrt((p * (1 - p)) / DRAWS));
        }
        expect(total).toBeCloseTo(1, 12);
    });

    it("picks first in proportion to weight: 1, 2, 3 and 6 out of 12", () => {
        const first = (id: string) => [...counts].filter(([order]) => order[0] === id).reduce((n, [, c]) => n + c, 0) / DRAWS;
        for (const [id, w] of Object.entries(WEIGHTS)) {
            const p = w / 12;
            expect(Math.abs(first(id) - p)).toBeLessThan(5 * Math.sqrt((p * (1 - p)) / DRAWS));
        }
    });

    it("is the same for the same seed, differs for another, and keeps every song once", () => {
        const one = weightedOrder(songs, (s) => WEIGHTS[s.id], "seed");
        expect(weightedOrder(songs, (s) => WEIGHTS[s.id], "seed")).toEqual(one);
        expect(one.map((s) => s.id).sort()).toEqual(["a", "b", "c", "d"]);
        expect(Array.from({ length: 30 }, (_, i) => weightedOrder(songs, (s) => WEIGHTS[s.id], `s${i}`).map((s) => s.id).join("")).filter((x, i, xs) => xs.indexOf(x) === i).length).toBeGreaterThan(5);
    });
});
