/**
 * The radio page's mood stations are the server's list (GET /library/radio/stations, names and generated subtitles)
 * as tiles: in its order, with its words, any station starting with any songs, and only where the vibe analyzer runs,
 * since their songs are chosen by moods scored from sound vectors.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/audio-controls-context", () => ({ useAudioControls: () => ({}) }));

import { STATIC_STATIONS, buildMoodStations, playableStations } from "@/features/home/radioData";

const server = [
    { value: "calm", name: "Calm", description: "Calm, dreamy, low energy" },
    { value: "wildcard", name: "Wildcard", description: "Songs with no mood tag" },
    { value: "brand-new", name: "Brand New", description: "Epic, high energy" },
];

/** Every station value the server lists, read from its station table, so a station added there is covered here. */
function serverStationValues(): string[] {
    const source = readFileSync(path.resolve(__dirname, "../../../backend/src/services/mixes/stations.ts"), "utf8");
    const values = [...source.matchAll(/\{ value: "([a-z0-9-]+)", name: /g)].map((m) => m[1]);
    if (values.length === 0) throw new Error("no stations found in the server's station table");
    return values;
}

describe("the mood stations", () => {
    it("every one the server lists plays as type mood with its own value", () => {
        const values = serverStationValues();
        const tiles = buildMoodStations(values.map((value) => ({ value, name: value, description: value })));
        expect(tiles).toHaveLength(values.length);
        tiles.forEach((tile, i) => expect(tile.filter).toEqual({ type: "mood", value: values[i] }));
    });

    it("are the server's stations, in its order and with its names and subtitles, played as type mood", () => {
        const tiles = buildMoodStations(server);
        expect(tiles.map((t) => [t.id, t.name, t.description, t.filter])).toEqual([
            ["mood-calm", "Calm", "Calm, dreamy, low energy", { type: "mood", value: "calm" }],
            ["mood-wildcard", "Wildcard", "Songs with no mood tag", { type: "mood", value: "wildcard" }],
            ["mood-brand-new", "Brand New", "Epic, high energy", { type: "mood", value: "brand-new" }],
        ]);
    });

    it("give a station the page has no colours for the default ones, so a new station still shows", () => {
        const [calm, , fresh] = buildMoodStations(server);
        expect(calm.color).toContain("#5bc2b4");
        expect(fresh.color).toBe("from-[#6b7280]/15 to-[#4b5563]/10");
    });

    it("every station the server lists has its own colours, none the default, so a renamed or replaced one is caught", () => {
        const values = serverStationValues();
        const tiles = buildMoodStations(values.map((value) => ({ value, name: value, description: value })));
        const fallback = buildMoodStations([{ value: "no-such-station", name: "x", description: "x" }])[0].color;
        tiles.forEach((tile) => expect(tile.color, tile.id).not.toBe(fallback));
        expect(values).toEqual(expect.arrayContaining(["focus-calm", "focus-energy", "late-night"]));
        expect(values).not.toContain("focus");
        expect(values).not.toContain("summer");
    });

    it("start with any songs at all, since a station plays however few match", () => {
        for (const station of [...buildMoodStations(server), STATIC_STATIONS.find((s) => s.id === "workout")!]) {
            expect(station.minTracks).toBe(1);
        }
    });

    it("and the workout station are left out where the vibe analyzer does not run; the rest stay", () => {
        const tiles = buildMoodStations(server);
        expect(playableStations(tiles, false)).toEqual([]);
        expect(playableStations(tiles, true)).toEqual(tiles);
        expect(playableStations(STATIC_STATIONS, false).map((s) => s.id)).toEqual(["all", "discovery", "favorites"]);
        expect(playableStations(STATIC_STATIONS, true)).toEqual(STATIC_STATIONS);
    });
});
