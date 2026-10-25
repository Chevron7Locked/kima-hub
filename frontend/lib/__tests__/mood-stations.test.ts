/**
 * The radio page's mood stations are the ones the server plays: every MOOD_STATIONS key and Wildcard, nothing else,
 * and they are offered only where the vibe analyzer runs, since their songs are chosen by moods scored from sound
 * vectors.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/audio-controls-context", () => ({ useAudioControls: () => ({}) }));

import { MOOD_STATIONS, STATIC_STATIONS, playableStations } from "@/features/home/radioData";

const BACKEND = path.resolve(__dirname, "../../../backend/src");

function routeSource(): string {
    return readFileSync(path.join(BACKEND, "routes/library/tracks.ts"), "utf8");
}

function serverMoodStations(): string[] {
    const source = routeSource();
    const map = source.match(/const MOOD_STATIONS = new Map\(\[([\s\S]*?)\]\);/);
    if (!map) throw new Error("MOOD_STATIONS not found in the radio route");
    const keys = [...map[1].matchAll(/\["([a-z-]+)",/g)].map((m) => m[1]);
    const wildcard = source.match(/const WILDCARD_STATION = "([a-z-]+)";/);
    if (!wildcard) throw new Error("WILDCARD_STATION not found in the radio route");
    return [...keys, wildcard[1]];
}

/** Each station's recipe id (MOOD_STATIONS' values); Wildcard has none. */
function serverRecipes(): Map<string, string> {
    const map = routeSource().match(/const MOOD_STATIONS = new Map\(\[([\s\S]*?)\]\);/)!;
    return new Map([...map[1].matchAll(/\["([a-z-]+)", "([a-z-]+)"\]/g)].map((m) => [m[1], m[2]]));
}

/** How a recipe part reads in a subtitle; a part missing here fails the test rather than being guessed. */
const WORDS: Record<string, string> = {
    calm: "calm", dreamy: "dreamy", party: "party", energetic: "energetic", groovy: "groovy",
    aggressive: "aggressive", dark: "dark", fun_quirky: "quirky", happy: "happy", uplifting: "uplifting",
    sad: "sad", romantic: "romantic", summer: "summery", instrumental: "instrumental", focus: "focused",
    night: "night-time", driving: "driving", nostalgic: "nostalgic", epic: "epic", sleep: "sleepy",
    arousal: "high energy", "low:arousal": "low energy",
};

function word(part: string): string {
    const known = WORDS[part] ?? (part.startsWith("low:") && WORDS[part.slice(4)] ? `not ${WORDS[part.slice(4)]}` : null);
    if (!known) throw new Error(`no subtitle word for recipe part ${part}`);
    return known;
}

/** The three heaviest parts of a recipe, ties kept in the recipe's own order. */
function topThree(components: Record<string, number>): string[] {
    return Object.entries(components)
        .map(([part, weight], order) => ({ part, weight, order }))
        .sort((a, b) => b.weight - a.weight || a.order - b.order)
        .slice(0, 3)
        .map((c) => c.part);
}

describe("the mood stations", () => {
    it("each name the three heaviest parts of their recipe, by one rule", () => {
        const recipes = JSON.parse(readFileSync(path.join(BACKEND, "services/mixes/recipes.json"), "utf8"));
        const recipeOf = serverRecipes();
        for (const station of MOOD_STATIONS) {
            const value = station.filter.value!;
            if (value === "wildcard") {
                expect(station.description).toBe("Songs with no mood tag");
                continue;
            }
            const words = topThree(recipes[recipeOf.get(value)!].components).map(word).join(", ");
            expect(station.description).toBe(words.charAt(0).toUpperCase() + words.slice(1));
        }
    });

    it("start with any songs at all, since a station plays however few match", () => {
        for (const station of [...MOOD_STATIONS, STATIC_STATIONS.find((s) => s.id === "workout")!]) {
            expect(station.minTracks).toBe(1);
        }
    });

    it("are exactly the server's 13 mood stations and Wildcard, in its order", () => {
        const server = serverMoodStations();
        expect(server).toHaveLength(14);
        expect(MOOD_STATIONS.map((s) => s.filter.value)).toEqual(server);
        expect(MOOD_STATIONS.every((s) => s.filter.type === "mood")).toBe(true);
    });

    it("have unique ids and a name and subtitle each", () => {
        const ids = [...STATIC_STATIONS, ...MOOD_STATIONS].map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const station of MOOD_STATIONS) {
            expect(station.name.length).toBeGreaterThan(0);
            expect(station.description.length).toBeGreaterThan(0);
        }
    });

    it("and the workout station are left out where the vibe analyzer does not run; the rest stay", () => {
        expect(playableStations(MOOD_STATIONS, false)).toEqual([]);
        expect(playableStations(MOOD_STATIONS, true)).toEqual(MOOD_STATIONS);
        expect(playableStations(STATIC_STATIONS, false).map((s) => s.id)).toEqual(["all", "discovery", "favorites"]);
        expect(playableStations(STATIC_STATIONS, true)).toEqual(STATIC_STATIONS);
    });
});
