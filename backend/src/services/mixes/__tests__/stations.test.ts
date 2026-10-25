/**
 * The mood stations' subtitles come from their recipes by one rule: the three heaviest parts, ties in the recipe's
 * order, each part by its recipe name (underscores as spaces), "not" before a "low:" part, and arousal as "high energy"
 * or "low energy". Wildcard, which has no recipe, says it plays the songs with no mood tag.
 */
import express from "express";
import request from "supertest";
import { parseRecipes } from "../recipes";
import { MOOD_STATIONS, moodStationList, stationSubtitle } from "../stations";

const recipe = (components: Record<string, number>) => parseRecipes({ test: { name: "Test", components } }).get("test")!;

describe("a station's subtitle", () => {
    it("names the three heaviest parts, a low: part with not and arousal as energy", () => {
        expect(stationSubtitle(recipe({ calm: 0.1, "low:sleep": 0.5, arousal: 0.3, dark: 0.2 }))).toBe(
            "Not sleep, high energy, dark",
        );
        expect(stationSubtitle(recipe({ "low:arousal": 0.4, fun_quirky: 0.3, happy: 0.1 }))).toBe(
            "Low energy, fun quirky, happy",
        );
    });

    it("keeps ties in the recipe's order, whatever their names", () => {
        expect(stationSubtitle(recipe({ sad: 2, romantic: 1, dreamy: 1, calm: 1 }))).toBe("Sad, romantic, dreamy");
        expect(stationSubtitle(recipe({ sad: 2, dreamy: 1, romantic: 1 }))).toBe("Sad, dreamy, romantic");
    });

    it("follows the recipe: a changed weight changes the line with nothing else edited", () => {
        expect(stationSubtitle(recipe({ summer: 0.35, happy: 0.2, groovy: 0.175 }))).toBe("Summer, happy, groovy");
        expect(stationSubtitle(recipe({ summer: 0.35, happy: 0.2, groovy: 0.25 }))).toBe("Summer, groovy, happy");
    });

    it("names every part a recipe has when it has fewer than three", () => {
        expect(stationSubtitle(recipe({ epic: 1 }))).toBe("Epic");
    });
});

describe("the shipped stations", () => {
    it("are the 13 approved recipe stations and Wildcard, each with its generated line", () => {
        // What the rule makes of recipes.json today, written out so a reader sees the actual lines.
        expect(moodStationList()).toEqual([
            { value: "calm", name: "Calm", description: "Calm, dreamy, low energy" },
            { value: "energy", name: "Energy", description: "Party, energetic, groovy" },
            { value: "intense", name: "Intense", description: "Aggressive, dark, fun quirky" },
            { value: "happy", name: "Happy", description: "Happy, uplifting, high energy" },
            { value: "melancholy", name: "Melancholy", description: "Sad, low energy, romantic" },
            { value: "summer", name: "Summer", description: "Summer, happy, groovy" },
            { value: "focus", name: "Focus", description: "Instrumental, focus, calm" },
            { value: "feel-good", name: "Feel-good", description: "Not sleep, not dark, uplifting" },
            { value: "late-night", name: "Late Night", description: "Night, calm, low energy" },
            { value: "romantic", name: "Romantic", description: "Romantic, sad, groovy" },
            { value: "road-trip", name: "Road Trip", description: "Driving, uplifting, summer" },
            { value: "nostalgic", name: "Nostalgic", description: "Nostalgic, high energy, happy" },
            { value: "epic", name: "Epic", description: "Epic, high energy, uplifting" },
            { value: "wildcard", name: "Wildcard", description: "Songs with no mood tag" },
        ]);
    });

    it("are the ones the radio route plays", () => {
        expect(MOOD_STATIONS.get("wildcard")?.recipe).toBeNull();
        expect(MOOD_STATIONS.get("late-night")?.recipe).toBe("late-night");
    });

    it("are listed at GET /radio/stations", async () => {
        const { default: tracksRoutes } = await import("../../../routes/library/tracks");
        const app = express();
        app.use(tracksRoutes);
        const res = await request(app).get("/radio/stations");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ stations: moodStationList() });
    });
});
