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

function serverMoodStations(): string[] {
    const source = readFileSync(path.resolve(__dirname, "../../../backend/src/routes/library/tracks.ts"), "utf8");
    const map = source.match(/const MOOD_STATIONS = new Map\(\[([\s\S]*?)\]\);/);
    if (!map) throw new Error("MOOD_STATIONS not found in the radio route");
    const keys = [...map[1].matchAll(/\["([a-z-]+)",/g)].map((m) => m[1]);
    const wildcard = source.match(/const WILDCARD_STATION = "([a-z-]+)";/);
    if (!wildcard) throw new Error("WILDCARD_STATION not found in the radio route");
    return [...keys, wildcard[1]];
}

describe("the mood stations", () => {
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
