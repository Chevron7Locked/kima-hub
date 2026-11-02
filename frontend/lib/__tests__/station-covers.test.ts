/**
 * A station tile shows the cover the server picked for it today, washed in the station's colour. A page's stations and
 * their covers come in one reply (GET /library/radio/row), which buildRadioRow turns into tiles.
 */
import { describe, expect, it } from "vitest";
import {
    DEFAULT_STYLE,
    STATIC_STATIONS,
    buildDecadeStations,
    buildGenreStations,
    buildMoodStations,
    buildRadioRow,
    stationHue,
    stationParams,
} from "@/features/home/radioData";

const calm = buildMoodStations([{ value: "calm", name: "Calm", description: "" }])[0];

describe("buildRadioRow", () => {
    const reply = [
        { type: "favorites" as const, value: null, cover: "f" },
        { type: "all" as const, value: null, cover: "a" },
        { type: "mood" as const, value: "calm", name: "Calm", description: "Calm, dreamy", cover: null },
        { type: "genre" as const, value: "rock", count: 20, cover: "r" },
        { type: "decade" as const, value: "1990", count: 30, cover: "n" },
    ];

    it("builds each section's tiles, the quick ones in their usual order", () => {
        const row = buildRadioRow(reply);
        expect(row.quick.map((s) => s.id)).toEqual(["all", "favorites"]);
        expect(row.moods.map((s) => [s.id, s.name, s.description])).toEqual([["mood-calm", "Calm", "Calm, dreamy"]]);
        expect(row.genres).toEqual(buildGenreStations([{ genre: "rock", count: 20 }]));
        expect(row.decades).toEqual(buildDecadeStations([{ decade: 1990, count: 30 }]));
    });

    it("matches each cover to its tile", () => {
        const { covers } = buildRadioRow(reply);
        expect(covers.get("all")).toBe("a");
        expect(covers.get("favorites")).toBe("f");
        expect(covers.get("mood-calm")).toBeNull();
        expect(covers.get("genre-rock")).toBe("r");
        expect(covers.get("decade-1990")).toBe("n");
    });
});

describe("stationHue", () => {
    it("reads the station's colour", () => {
        expect(stationHue(calm)).toBe("#5bc2b4");
        expect(stationHue(buildDecadeStations([{ decade: 1980, count: 20 }])[0])).toBe("#22d3ee");
    });

    it("every station has one", () => {
        const defaults = { id: "x", name: "x", description: "", ...DEFAULT_STYLE, filter: { type: "all" as const }, minTracks: 1 };
        for (const station of [...STATIC_STATIONS, defaults]) expect(stationHue(station)).toMatch(/^#[0-9a-f]{6}$/i);
    });
});

describe("stationParams", () => {
    it("asks a station to play with its type and value, and the listener time zone", () => {
        const params = stationParams(calm, 12);
        expect(params.get("type")).toBe("mood");
        expect(params.get("value")).toBe("calm");
        expect(params.get("limit")).toBe("12");
        expect(params.get("tz")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(stationParams(STATIC_STATIONS[0], 100).has("value")).toBe(false);
    });
});
