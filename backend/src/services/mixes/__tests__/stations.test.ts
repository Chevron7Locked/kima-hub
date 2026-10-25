/**
 * The mood stations' subtitles come from their recipes by one rule: the three heaviest parts the recipe leans toward,
 * ties in the recipe's order, each by its recipe name (underscores as spaces); a "low:" part is left out, except
 * arousal, which reads "high energy" or "low energy". Wildcard, which has no recipe, says it plays the songs with no
 * mood tag.
 */
import express from "express";
import request from "supertest";
import { parseRecipes } from "../recipes";
import { MOOD_STATIONS, stationSubtitle } from "../stations";

const recipe = (components: Record<string, number>) => parseRecipes({ test: { name: "Test", components } }).get("test")!;

describe("a station's subtitle", () => {
    it("names the three heaviest parts it leans toward, leaving out what it pushes away", () => {
        expect(stationSubtitle(recipe({ "low:sleep": 0.175, "low:dark": 0.15, uplifting: 0.125, happy: 0.112 }))).toBe(
            "Uplifting, happy",
        );
        expect(stationSubtitle(recipe({ calm: 0.1, "low:sleep": 0.5, dark: 0.2, epic: 0.15 }))).toBe("Dark, epic, calm");
    });

    it("reads arousal either way, as high or low energy", () => {
        expect(stationSubtitle(recipe({ "low:arousal": 0.4, calm: 0.3, dreamy: 0.1 }))).toBe("Low energy, calm, dreamy");
        expect(stationSubtitle(recipe({ epic: 0.45, arousal: 0.2, uplifting: 0.15 }))).toBe("Epic, high energy, uplifting");
    });

    it("reads underscores as spaces", () => {
        expect(stationSubtitle(recipe({ aggressive: 0.3, fun_quirky: 0.2 }))).toBe("Aggressive, fun quirky");
    });

    it("keeps ties in the recipe's order, whatever their names", () => {
        expect(stationSubtitle(recipe({ sad: 2, romantic: 1, dreamy: 1, calm: 1 }))).toBe("Sad, romantic, dreamy");
        expect(stationSubtitle(recipe({ sad: 2, dreamy: 1, romantic: 1 }))).toBe("Sad, dreamy, romantic");
    });

    it("follows the recipe: a changed weight changes the line with nothing else edited", () => {
        expect(stationSubtitle(recipe({ summer: 0.35, happy: 0.2, groovy: 0.175 }))).toBe("Summer, happy, groovy");
        expect(stationSubtitle(recipe({ summer: 0.35, happy: 0.2, groovy: 0.25 }))).toBe("Summer, groovy, happy");
    });

    it("names every part when there are fewer than three, and refuses a recipe that leans toward nothing", () => {
        expect(stationSubtitle(recipe({ epic: 1 }))).toBe("Epic");
        expect(() => stationSubtitle(recipe({ "low:sleep": 1, "low:dark": 1 }))).toThrow(/no subtitle/);
    });
});

describe("the shipped stations", () => {
    it("play the recipes the radio route expects; Wildcard has none", () => {
        expect(MOOD_STATIONS.get("wildcard")?.recipe).toBeNull();
        expect(MOOD_STATIONS.get("late-night")?.recipe).toBe("late-night");
    });

    it("are listed at GET /radio/stations: the 13 approved stations then Wildcard, each with its subtitle", async () => {
        const { default: tracksRoutes } = await import("../../../routes/library/tracks");
        const app = express();
        app.use(tracksRoutes);
        const res = await request(app).get("/radio/stations");
        expect(res.status).toBe(200);

        const stations: Array<Record<string, unknown>> = res.body.stations;
        // The approved names and order (kima-labs stations_2026-10-24.json; Kevin 10-24 01:19 named Wildcard).
        expect(stations.map((s) => [s.value, s.name])).toEqual([
            ["calm", "Calm"], ["energy", "Energy"], ["intense", "Intense"], ["happy", "Happy"],
            ["melancholy", "Melancholy"], ["focus-calm", "Focus: Calm"], ["focus-energy", "Focus: Energy"], ["feel-good", "Feel-good"],
            ["late-night", "Late Night"], ["romantic", "Romantic"], ["road-trip", "Road Trip"],
            ["nostalgic", "Nostalgic"], ["epic", "Epic"], ["wildcard", "Wildcard"],
        ]);
        for (const station of stations) {
            expect(Object.keys(station).sort()).toEqual(["description", "name", "value"]);
            expect(typeof station.description).toBe("string");
            expect((station.description as string).length).toBeGreaterThan(0);
        }
        expect(stations[13].description).toBe("Songs with no mood tag");
        // Kevin 10-25: the recipe's parts only, never what it pushes away. Feel-good's recipe is mostly "low:" parts.
        expect(stations[7].description).toBe("Uplifting, happy, epic");
        // Late Night plays the listener's own night plays, so it says that instead of the fallback recipe's parts.
        expect(stations[8].description).toBe("The songs you play after dark, and songs like them");
    });
});
