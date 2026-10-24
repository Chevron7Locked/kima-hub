/**
 * A mix draws from every track that matches its filter, uniformly at random,
 * not from the first rows the database returns. Only ids are read for the
 * whole match; full rows are read for the draw. A seed repeats a draw; the
 * database's seeded draw is checked in mixes/__tests__/seededDraw.integration.test.ts.
 */
const mockFindMany = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: { track: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

import { drawIds, drawWeighted, sampleTrackIds, sampleTracks, seededKey, seededOrder, seededTake, tracksByIds } from "../mixes/helpers";

const TOTAL = 1000;
const ALL_IDS = Array.from({ length: TOTAL }, (_, i) => `t${String(i).padStart(4, "0")}`);

/** An in-memory track table: an id-only read returns every id, an id-list read returns those rows. */
function fakeTable() {
    mockFindMany.mockImplementation(async (args: any) => {
        if (args.select) return ALL_IDS.map((id) => ({ id }));
        const wanted: string[] = args.where.id.in;
        return [...wanted].reverse().map((id) => ({ id, album: { coverUrl: null } }));
    });
}

beforeEach(() => {
    mockFindMany.mockReset();
    fakeTable();
});

describe("sampleTracks", () => {
    it("reads every matching id (no take, id order) and full rows only for the draw", async () => {
        const rows = await sampleTracks({ where: {}, include: { album: true }, take: 50 });

        const [idRead, rowRead] = mockFindMany.mock.calls.map((c) => c[0]);
        expect(idRead.select).toEqual({ id: true });
        expect(idRead.take).toBeUndefined();
        expect(idRead.orderBy).toEqual({ id: "asc" });
        expect(rowRead.where.id.in).toHaveLength(50);
        expect(rows).toHaveLength(50);
    });

    it("draws from beyond the first rows, across the whole match", async () => {
        const rows = await sampleTracks({ where: {}, include: { album: true }, take: 50 });
        const indexes = rows.map((r: any) => ALL_IDS.indexOf(r.id));
        expect(Math.max(...indexes)).toBeGreaterThan(500);
        expect(indexes.filter((i) => i >= 50).length).toBeGreaterThan(25);
    });

    it("returns rows in the order drawn, whatever order the database returns them", async () => {
        const rows = await sampleTracks({ where: {}, include: { album: true }, take: 20 });
        const [, rowRead] = mockFindMany.mock.calls.map((c) => c[0]);
        expect(rows.map((r: any) => r.id)).toEqual(rowRead.where.id.in);
    });

    it("returns every match when fewer than take match", async () => {
        mockFindMany.mockImplementation(async (args: any) =>
            args.select ? [{ id: "a" }, { id: "b" }] : args.where.id.in.map((id: string) => ({ id }))
        );
        const rows = await sampleTracks({ where: {}, include: { album: true }, take: 50 });
        expect(rows).toHaveLength(2);
    });

    it("skips the row read when nothing matches", async () => {
        mockFindMany.mockResolvedValue([]);
        expect(await sampleTracks({ where: {}, include: { album: true }, take: 50 })).toEqual([]);
        expect(mockFindMany).toHaveBeenCalledTimes(1);
    });
});

describe("sampleTrackIds", () => {
    it("reads ids only, draws take from the whole match, and differs between unseeded calls", async () => {
        const a = await sampleTrackIds({ where: {}, take: 100 });
        const b = await sampleTrackIds({ where: {}, take: 100 });
        expect(mockFindMany).toHaveBeenCalledTimes(2);
        expect(mockFindMany.mock.calls[0][0].select).toEqual({ id: true });
        expect(mockFindMany.mock.calls[0][0].take).toBeUndefined();
        expect(a).toHaveLength(100);
        expect(new Set(a).size).toBe(100);
        expect(a).not.toEqual(b);
        expect(a.filter((id) => ALL_IDS.indexOf(id) >= 300).length).toBeGreaterThan(40);
    });

    it("a station refilling 10 times reaches far more than one pool", async () => {
        const seen = new Set<string>();
        for (let i = 0; i < 10; i++) for (const id of await sampleTrackIds({ where: {}, take: 100 })) seen.add(id);
        expect(seen.size).toBeGreaterThan(500);
    });
});

describe("drawIds", () => {
    it("is uniform: each id is drawn about as often as any other", () => {
        const ids = Array.from({ length: 10 }, (_, i) => `i${i}`);
        const counts = new Map<string, number>();
        for (let s = 1; s <= 2000; s++) {
            for (const id of drawIds(ids, 3, s * 7919)) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        // Expected 600 each; allow a wide band so the test is not flaky.
        for (const id of ids) expect(counts.get(id)).toBeGreaterThan(450);
        for (const id of ids) expect(counts.get(id)).toBeLessThan(750);
    });

    it("with a seed, draws the same ids whatever order they come in", () => {
        const ids = Array.from({ length: 300 }, (_, i) => `t${i}`);
        expect(drawIds([...ids].reverse(), 20, 42)).toEqual(drawIds(ids, 20, 42));
    });

    it("with a seed, keeps every other pick when one id leaves or joins the candidates", () => {
        const ids = Array.from({ length: 300 }, (_, i) => `t${i}`);
        const day = drawIds(ids, 20, 42);
        // A picked id leaves: the other 19 stay, in their order, and one more comes in at the end.
        const withoutPick = drawIds(ids.filter((id) => id !== day[7]), 20, 42);
        expect(withoutPick.slice(0, 19)).toEqual(day.filter((id) => id !== day[7]));
        // An id that was not picked leaves, or a new one joins and ranks below the 20th: nothing changes.
        const unpicked = ids.find((id) => !day.includes(id))!;
        expect(drawIds(ids.filter((id) => id !== unpicked), 20, 42)).toEqual(day);
        const joined = drawIds([...ids, "new"], 20, 42);
        expect(joined.filter((id) => id !== "new")).toEqual(joined.includes("new") ? day.slice(0, 19) : day);
    });
});

describe("seededKey", () => {
    it("is the hex MD5 of seed, colon, id, the key Postgres computes as md5('42' || ':' || 't1')", () => {
        // A changed key would reshuffle every seeded mix and part from the database's draws.
        expect(seededKey(42, "t1")).toBe("00e5e273cc89b20ab75ed70dcf8dee08");
        expect(seededKey("42", "t1")).toBe(seededKey(42, "t1"));
    });
});

describe("seededTake", () => {
    it("is the first `take` of seededOrder, for any take, without sorting the whole list", () => {
        const ids = Array.from({ length: 500 }, (_, i) => `t${i}`);
        for (const seed of [1, 42, 987654321]) {
            const order = seededOrder(ids, seed, (id) => id);
            for (const take of [1, 2, 20, 499, 500, 800]) expect(seededTake(ids, seed, (id) => id, take)).toEqual(order.slice(0, take));
        }
        expect(seededTake([], 1, (id: string) => id, 5)).toEqual([]);
    });
});

describe("a draw refuses a take that is not a positive integer", () => {
    const bad = [0, -5, 2.5, NaN, Infinity];
    it.each(bad)("drawIds throws for %p", (take) => {
        expect(() => drawIds(["a", "b", "c"], take)).toThrow(RangeError);
    });
    it.each(bad)("drawWeighted throws for %p", (take) => {
        expect(() => drawWeighted([1, 2, 3], (x) => x, take)).toThrow(RangeError);
    });
    it.each(bad)("sampleTrackIds rejects for %p without reading", async (take) => {
        mockFindMany.mockClear();
        await expect(sampleTrackIds({ where: {}, take })).rejects.toThrow(RangeError);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
});

describe("drawWeighted", () => {
    const items = [
        { id: "heavy", w: 9 },
        { id: "mid", w: 3 },
        { id: "light", w: 1 },
        { id: "zero", w: 0 },
        { id: "negative", w: -2 },
        { id: "nan", w: NaN },
    ];

    it("picks higher weights more often, reaches every positive weight, and never a zero, negative or NaN", () => {
        const counts = new Map<string, number>();
        for (let i = 0; i < 4000; i++) {
            const [first] = drawWeighted(items, (x) => x.w, 1);
            counts.set(first.id, (counts.get(first.id) ?? 0) + 1);
        }
        // First pick is proportional to weight: 9/13, 3/13, 1/13 of 4000.
        expect(counts.get("heavy")!).toBeGreaterThan(counts.get("mid")! * 2);
        expect(counts.get("mid")!).toBeGreaterThan(counts.get("light")! * 2);
        expect(counts.get("light")!).toBeGreaterThan(0);
        for (const id of ["zero", "negative", "nan"]) expect(counts.has(id)).toBe(false);
    });

    it("returns `take` distinct items, or only the positive ones when fewer", () => {
        expect(drawWeighted(items, (x) => x.w, 2)).toHaveLength(2);
        const all = drawWeighted(items, (x) => x.w, 10);
        expect(all.map((x) => x.id).sort()).toEqual(["heavy", "light", "mid"]);
        expect(drawWeighted([], (x: { w: number }) => x.w, 5)).toEqual([]);
    });
});

describe("tracksByIds", () => {
    it("keeps the order of the ids and reads nothing for none", async () => {
        const rows = await tracksByIds(["x", "y", "z"], { album: true });
        expect(rows.map((r) => r.id)).toEqual(["x", "y", "z"]);
        mockFindMany.mockClear();
        expect(await tracksByIds([], { album: true })).toEqual([]);
        expect(mockFindMany).not.toHaveBeenCalled();
    });
});
