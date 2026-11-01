/**
 * A station tile shows the cover the server picked for it today, washed in the station's colour. A page asks for all
 * its tiles' covers in one request (coverRequest / coversByStation) rather than calling each station.
 */
import { describe, expect, it } from "vitest";
import {
    DEFAULT_STYLE,
    STATIC_STATIONS,
    buildDecadeStations,
    buildGenreStations,
    buildMoodStations,
    coverRequest,
    coversByStation,
    stationHue,
    stationParams,
} from "@/features/home/radioData";

const calm = buildMoodStations([{ value: "calm", name: "Calm", description: "" }])[0];

describe("coverRequest", () => {
    it("lists each station's type and, when it has one, its value, in the page's order", () => {
        const stations = [STATIC_STATIONS[0], calm, ...buildGenreStations([{ genre: "rock", count: 20 }]), ...buildDecadeStations([{ decade: 1990, count: 30 }])];
        expect(coverRequest(stations)).toEqual([
            { type: "all" },
            { type: "mood", value: "calm" },
            { type: "genre", value: "rock" },
            { type: "decade", value: "1990" },
        ]);
    });
});

describe("coversByStation", () => {
    it("matches each cover to its station by type and value", () => {
        const rock = buildGenreStations([{ genre: "rock", count: 20 }])[0];
        const covers = coversByStation([STATIC_STATIONS[0], calm, rock], {
            covers: [
                { type: "genre", value: "rock", cover: "r" },
                { type: "all", value: null, cover: "a" },
                { type: "mood", value: "calm", cover: null },
            ],
        });
        expect(covers.get("all")).toBe("a");
        expect(covers.get("mood-calm")).toBeNull();
        expect(covers.get("genre-rock")).toBe("r");
    });

    it("gives a station the reply leaves out no cover", () => {
        expect(coversByStation([calm], { covers: [] }).get("mood-calm")).toBeNull();
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
