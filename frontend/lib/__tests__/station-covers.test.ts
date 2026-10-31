/**
 * A station tile shows the cover of a song the station would play, from the same request the station starts with,
 * washed in the station's colour. Cover requests run at most four at a time.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, STATIC_STATIONS, buildMoodStations, buildDecadeStations, stationCover, stationHue, stationParams } from "@/features/home/radioData";

const track = (id: string, album: string, coverArt?: string) => ({ id, album: { id: album, title: album, coverArt } });

describe("stationCover", () => {
    it("takes the first cover in play order, skipping songs with none", () => {
        expect(stationCover([track("1", "a"), track("2", "b", "cb"), track("3", "c", "cc")])).toBe("cb");
    });

    it("is null when no song has a cover", () => {
        expect(stationCover([track("1", "a")])).toBeNull();
        expect(stationCover([])).toBeNull();
    });
});

describe("stationParams", () => {
    it("asks for the station's type and value, and the listener's time zone", () => {
        const calm = buildMoodStations([{ value: "calm", name: "Calm", description: "" }])[0];
        const params = stationParams(calm, 12);
        expect(params.get("type")).toBe("mood");
        expect(params.get("value")).toBe("calm");
        expect(params.get("limit")).toBe("12");
        expect(params.get("tz")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });

    it("sends no value for a station without one", () => {
        expect(stationParams(STATIC_STATIONS[0], 100).has("value")).toBe(false);
    });
});

describe("stationHue", () => {
    it("reads the station's colour", () => {
        const calm = buildMoodStations([{ value: "calm", name: "Calm", description: "" }])[0];
        expect(stationHue(calm)).toBe("#5bc2b4");
        expect(stationHue(buildDecadeStations([{ decade: 1980, count: 20 }])[0])).toBe("#22d3ee");
    });

    it("every station has one", () => {
        const defaults = { id: "x", name: "x", description: "", ...DEFAULT_STYLE, filter: { type: "all" as const }, minTracks: 1 };
        for (const station of [...STATIC_STATIONS, defaults]) expect(stationHue(station)).toMatch(/^#[0-9a-f]{6}$/i);
    });
});

describe("the cover request queue", () => {
    // A new request can arrive at any moment while one finishes and a waiting one is woken: try each moment in turn.
    it.each([0, 1, 2, 3, 4, 5, 6])("never runs more than four, with a new request arriving %i steps after one finishes", async (steps) => {
        const { oneAtATurn } = await import("@/features/home/components/StationCard");
        let running = 0;
        let most = 0;
        const finish: (() => void)[] = [];
        const settle = async (n = 10) => {
            for (let i = 0; i < n; i++) await Promise.resolve();
        };
        const request = () =>
            oneAtATurn(
                () =>
                    new Promise<void>((done) => {
                        running++;
                        most = Math.max(most, running);
                        finish.push(() => {
                            running--;
                            done();
                        });
                    }),
            );
        const all = [request(), request(), request(), request(), request()];
        await settle();
        expect(running).toBe(4);
        finish.shift()!();
        await settle(steps);
        all.push(request());
        await settle();
        expect(most).toBe(4);
        while (finish.length) {
            finish.shift()!();
            await settle();
        }
        await Promise.all(all);
        expect(most).toBe(4);
    });
});
