/**
 * The recipes file as shipped, the checks that refuse a malformed recipe, and the seeded draw: repeatable per seed,
 * even across members, capped per artist with the cap relaxed only to reach the 8-song minimum.
 */
import { MIN_MIX_TRACKS, RECIPES, RECIPE_LINE, drawMembers, getRecipe, parseRecipes } from "../recipes";
import { TAG_LINE_Z } from "../../moods/tags";

const one = (entry: Record<string, unknown>) => () => parseRecipes({ test: { name: "Test", ...entry } });

describe("the shipped recipes", () => {
    it("put the line 1.25 SD above the library's mean, the mood buckets and song tags too (Kevin 10-24)", () => {
        expect(RECIPE_LINE).toBe(1.25);
        expect(TAG_LINE_Z).toBe(RECIPE_LINE);
    });

    it("has one recipe for every mood mix, rotating mix and mood page in W5's plan, and every station of 10-24", () => {
        expect([...RECIPES.keys()].sort()).toEqual([
            "acoustic", "calm", "calm-station", "chill", "coffee-shop", "dance-floor", "dreamy",
            "energetic", "energy-station", "epic", "feel-good-station", "focus", "focus-calm-station",
            "focus-energy-station", "golden-hour", "happy", "high-energy", "hot-girl-walk", "in-my-feelings", "instrumental", "intense",
            "intense-station", "late-night", "main-character", "melancholy", "melancholy-station", "midnight-drive",
            "monday-motivation", "nostalgic", "party", "rage-cleaning", "road-trip", "romantic-station", "romanticize",
            "sad-girl-sundays", "shower-karaoke", "sleep", "summer", "sunday-morning",
            "that-girl-era", "unhinged", "upbeat", "villain-era", "workout",
        ]);
    });

    it("gives the stations of 10-24 the approved blends", () => {
        // kima-labs research/w5-mixes-2026-10-22/stations_2026-10-24.json, two of them.
        expect(getRecipe("feel-good-station").components).toHaveLength(15);
        expect(getRecipe("focus-calm-station")).toMatchObject({
            components: [{ signal: "focus", weight: 0.75 }, { signal: "calm", weight: 0.25 }],
            filters: { arousalPct: [0, 0.75] },
        });
        expect(getRecipe("focus-energy-station")).toMatchObject({
            components: [
                { signal: "focus", weight: 0.6 },
                { signal: "energetic", weight: 0.25 },
                { signal: "groovy", weight: 0.15 },
            ],
            filters: { arousalPct: [0.5, 1] },
        });
        expect(getRecipe("melancholy-station").components).toContainEqual({ signal: "arousal", weight: -0.175 });
    });

    it("reads low: components as negative weights and the filters under their own names", () => {
        expect(getRecipe("happy").components).toEqual([
            { signal: "happy", weight: 40 },
            { signal: "uplifting", weight: 15 },
            { signal: "arousal", weight: 15 },
            { signal: "groovy", weight: 10 },
            { signal: "minor", weight: -10 },
            { signal: "instrumental", weight: -10 },
        ]);
        expect(getRecipe("focus")).toMatchObject({
            components: [{ signal: "focus", weight: 1 }, { signal: "instrumental", weight: 1.25 }],
            filters: { arousalPct: [0, 0.75] },
        });
        expect(getRecipe("dance-floor").filters).toEqual({ arousalPct: [0.5, 1], bpm: [110, 140] });
        expect(getRecipe("instrumental").filters).toEqual({ instrumentalMin: 0.5, arousalPct: [0, 0.75] });
        expect(getRecipe("shower-karaoke").filters).toEqual({ arousalPct: [0.35, 1], instrumentalMax: 0.5 });
    });

    it("refuses an id it does not know", () => {
        expect(() => getRecipe("no-such-mix")).toThrow("Unknown recipe: no-such-mix");
    });
});

describe("parseRecipes refuses", () => {
    it.each([
        ["an unknown mood", { components: { joyful: 1 } }, "unknown component joyful"],
        ["an unknown mood pushed away", { components: { calm: 1, "low:joyful": 1 } }, "unknown component joyful"],
        ["a component twice", { components: { calm: 1, "low:calm": 1 } }, "calm appears twice"],
        ["a zero weight", { components: { calm: 0 } }, "needs a positive weight"],
        ["a negative weight", { components: { calm: -1 } }, "needs a positive weight"],
        ["no components", { components: {} }, "no components"],
        ["an unknown filter", { components: { calm: 1 }, filters: { weekday: 0 } }, "unknown filter weekday"],
        ["a BPM band upside down", { components: { calm: 1 }, filters: { bpm: [140, 110] } }, "bpm must have"],
        ["a percentile past 1", { components: { calm: 1 }, filters: { arousal_pct: [0.5, 1.5] } }, "arousal_pct must have"],
        ["an instrumental bound past 1", { components: { calm: 1 }, filters: { instrumental_max: 2 } }, "a probability"],
        ["minor set false", { components: { calm: 1 }, filters: { minor: false } }, "minor must be true"],
        ["an unknown field", { components: { calm: 1 }, weekday: 0 }, "unknown field weekday"],
    ])("%s", (_, entry, message) => {
        expect(one(entry)).toThrow(message);
    });

    it("an id that is not lower-case words and hyphens, and a recipe without a name", () => {
        expect(() => parseRecipes({ "Chill Mix": { name: "Chill", components: { calm: 1 } } })).toThrow("the id must be");
        expect(() => parseRecipes({ chill: { components: { calm: 1 } } })).toThrow("no name");
    });
});

describe("drawMembers", () => {
    const members = (n: number, artistOf: (i: number) => string = (i) => `a${i}`) =>
        Array.from({ length: n }, (_, i) => ({ id: `t${String(i).padStart(3, "0")}`, artistId: artistOf(i) }));

    it("draws the same songs in the same order for one seed, other songs for another", () => {
        const pool = members(40);
        const draw = drawMembers(pool, "seed-1", 20);
        expect(draw).toHaveLength(20);
        expect(new Set(draw).size).toBe(20);
        expect(drawMembers([...pool].reverse(), "seed-1", 20)).toEqual(draw);
        expect(drawMembers(pool, "seed-2", 20)).not.toEqual(draw);
    });

    it("gives every member an equal chance: 4,000 seeds, each of 40 members drawn about half the time", () => {
        const pool = members(40);
        const counts = new Map(pool.map((m) => [m.id, 0]));
        const seeds = 4000;
        for (let s = 0; s < seeds; s++) for (const id of drawMembers(pool, `seed-${s}`, 20)) counts.set(id, counts.get(id)! + 1);
        // Each count is binomial(4000, 0.5): mean 2,000, SD 31.6; six SDs either side.
        for (const count of counts.values()) {
            expect(count).toBeGreaterThan(2000 - 190);
            expect(count).toBeLessThan(2000 + 190);
        }
    });

    it("keeps the others' order when a member joins", () => {
        const pool = members(30);
        const before = drawMembers(pool, "seed", 30);
        const after = drawMembers([...pool, { id: "t999", artistId: "a999" }], "seed", 31);
        expect(after.filter((id) => id !== "t999")).toEqual(before);
    });

    it("takes at most 2 songs per artist while that still makes 8", () => {
        const draw = drawMembers(members(12, (i) => `a${i % 4}`), "seed", 20);
        expect(draw).toHaveLength(8);
    });

    it("raises the cap to 3 when 2 per artist leaves fewer than 8", () => {
        const pool = members(12, (i) => `a${i % 3}`);
        const draw = drawMembers(pool, "seed", 20);
        expect(draw).toHaveLength(9);
        const perArtist = new Map<string, number>();
        for (const id of draw) {
            const artist = pool.find((m) => m.id === id)!.artistId;
            perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
        }
        expect([...perArtist.values()]).toEqual([3, 3, 3]);
    });

    it("lifts the cap when 3 per artist still leaves fewer than 8", () => {
        expect(drawMembers(members(10, () => "solo"), "seed", 20)).toHaveLength(10);
        expect(drawMembers(members(30, () => "solo"), "seed", 20)).toHaveLength(20);
    });

    it("returns every member when there are fewer than the limit", () => {
        expect(drawMembers(members(MIN_MIX_TRACKS + 1), "seed", 20)).toHaveLength(MIN_MIX_TRACKS + 1);
    });

    const perArtistOf = (pool: { id: string; artistId: string }[], draw: string[]) => {
        const counts = new Map<string, number>();
        for (const id of draw) {
            const artist = pool.find((m) => m.id === id)!.artistId;
            counts.set(artist, (counts.get(artist) ?? 0) + 1);
        }
        return counts;
    };

    it("keeps 2 per artist for a draw smaller than 8 that 2 per artist can fill", () => {
        // Two artists with ten songs each: a draw of 4 is two from each on every seed.
        const pool = members(20, (i) => `a${i % 2}`);
        for (let s = 0; s < 200; s++) {
            const draw = drawMembers(pool, `seed-${s}`, 4);
            expect(draw).toHaveLength(4);
            expect([...perArtistOf(pool, draw).values()]).toEqual([2, 2]);
        }
    });

    it("draws evenly within the cap: three artists, ten songs each, 3 per artist, each song about 30% of the time", () => {
        const pool = members(30, (i) => `a${i % 3}`);
        const counts = new Map(pool.map((m) => [m.id, 0]));
        const seeds = 4000;
        for (let s = 0; s < seeds; s++) {
            const draw = drawMembers(pool, `seed-${s}`, 20);
            // 2 per artist gives 6, under 8, so the cap is 3: nine songs, three from each artist.
            expect([...perArtistOf(pool, draw).values()]).toEqual([3, 3, 3]);
            for (const id of draw) counts.set(id, counts.get(id)! + 1);
        }
        // Each count is binomial(4000, 0.3): mean 1,200, SD 29; six SDs either side.
        for (const count of counts.values()) {
            expect(count).toBeGreaterThan(1200 - 174);
            expect(count).toBeLessThan(1200 + 174);
        }
    });
});
