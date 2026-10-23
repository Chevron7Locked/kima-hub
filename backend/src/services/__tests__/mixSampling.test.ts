/**
 * A mix draws from every track that matches its filter, uniformly at random,
 * not from the first rows the database returns. Only ids are read for the
 * whole match; full rows are read for the draw. A seed repeats a draw.
 */
const mockFindMany = jest.fn();
jest.mock("../../utils/db", () => ({
    prisma: { track: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

import { drawIds, drawWeighted, sampledMix, sampleTrackIds, sampleTracks, tracksByIds } from "../mixes/helpers";
import { generate3AMThoughts, generateUnhinged } from "../mixes/moodMixes";

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
        const rows = await sampleTracks({ where: {}, include: { album: true }, take: 50, seed: 7 });
        const indexes = rows.map((r: any) => ALL_IDS.indexOf(r.id));
        expect(Math.max(...indexes)).toBeGreaterThan(500);
        expect(indexes.filter((i) => i >= 50).length).toBeGreaterThan(25);
    });

    it("returns rows in the order drawn, whatever order the database returns them", async () => {
        const rows = await sampleTracks({ where: {}, include: { album: true }, take: 20, seed: 3 });
        expect(rows.map((r: any) => r.id)).toEqual(drawIds(ALL_IDS, 20, 3));
    });

    it("is repeatable with a seed and differs between seeds", async () => {
        const a = await sampleTracks({ where: {}, include: { album: true }, take: 30, seed: 11 });
        const b = await sampleTracks({ where: {}, include: { album: true }, take: 30, seed: 11 });
        const c = await sampleTracks({ where: {}, include: { album: true }, take: 30, seed: 12 });
        expect(a.map((r: any) => r.id)).toEqual(b.map((r: any) => r.id));
        expect(a.map((r: any) => r.id)).not.toEqual(c.map((r: any) => r.id));
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

describe("sampledMix output size", () => {
    const spec = {
        id: "m", type: "t", name: "n", description: "d", colorType: "default",
        where: {},
    };

    it("is `limit` when `take` or more tracks match", async () => {
        const mix = await sampledMix({ ...spec, take: 50, minTracks: 8, limit: 10 });
        expect(mix?.trackIds).toHaveLength(10);
        expect(mix?.trackCount).toBe(10);
        expect(new Set(mix?.trackIds).size).toBe(10);
    });

    it("is null when fewer than minTracks match", async () => {
        mockFindMany.mockImplementation(async (args: any) =>
            args.select ? ALL_IDS.slice(0, 7).map((id) => ({ id })) : args.where.id.in.map((id: string) => ({ id, album: { coverUrl: null } }))
        );
        expect(await sampledMix({ ...spec, take: 50, minTracks: 8, limit: 10 })).toBeNull();
    });

    it("is every match when fewer than `limit` match but enough make a mix", async () => {
        mockFindMany.mockImplementation(async (args: any) =>
            args.select ? ALL_IDS.slice(0, 9).map((id) => ({ id })) : args.where.id.in.map((id: string) => ({ id, album: { coverUrl: null } }))
        );
        const mix = await sampledMix({ ...spec, take: 50, minTracks: 8, limit: 10 });
        expect(mix?.trackIds).toHaveLength(9);
    });
});

describe("mix cut-offs are the hand-set values, not library-share matches", () => {
    it("Unhinged keeps valence 0.9 / 0.1", async () => {
        await generateUnhinged("u", "2026-10-21");
        const where = mockFindMany.mock.calls[0][0].where;
        const valenceEntries = where.OR.filter((c: any) => "valence" in c);
        expect(valenceEntries).toEqual([{ valence: { gte: 0.9 } }, { valence: { lte: 0.1 } }]);
    });

    it("3AM Thoughts keeps arousal 0.4, valence 0.5 and acousticness 0.3", async () => {
        await generate3AMThoughts("u", "2026-10-21");
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.AND[0]).toEqual({ arousal: { lte: 0.4 } });
        expect(where.AND[3]).toEqual({
            OR: [{ valence: { lte: 0.5 } }, { acousticness: { gte: 0.3 } }],
        });
    });
});
