/**
 * The mood stations: the 13 that play a recipe's members and Wildcard, the songs with no mood tag. The radio route
 * plays them and the apps list them from here (GET /library/radio/stations), each with a subtitle generated from its
 * recipe, so a changed recipe changes its subtitle with no hand edit.
 */
import { RECIPES, type Recipe, type RecipeComponent } from "./recipes";

export interface MoodStation {
    /** The radio route's `value` for `type=mood`. */
    value: string;
    name: string;
    /** The recipe the station plays; none for Wildcard. */
    recipe: string | null;
}

/** The stations in the order they were approved (stations_2026-10-24.json); five share their mix's recipe. */
const STATIONS: MoodStation[] = [
    { value: "calm", name: "Calm", recipe: "calm-station" },
    { value: "energy", name: "Energy", recipe: "energy-station" },
    { value: "intense", name: "Intense", recipe: "intense-station" },
    { value: "happy", name: "Happy", recipe: "happy" },
    { value: "melancholy", name: "Melancholy", recipe: "melancholy-station" },
    { value: "summer", name: "Summer", recipe: "summer-station" },
    { value: "focus", name: "Focus", recipe: "focus-station" },
    { value: "feel-good", name: "Feel-good", recipe: "feel-good-station" },
    { value: "late-night", name: "Late Night", recipe: "late-night" },
    { value: "romantic", name: "Romantic", recipe: "romantic-station" },
    { value: "road-trip", name: "Road Trip", recipe: "road-trip" },
    { value: "nostalgic", name: "Nostalgic", recipe: "nostalgic" },
    { value: "epic", name: "Epic", recipe: "epic" },
    { value: "wildcard", name: "Wildcard", recipe: null },
];

const WILDCARD_SUBTITLE = "Songs with no mood tag";

/**
 * A part as its recipe names it, underscores read as spaces; arousal, the felt-energy reading, as "high energy" or
 * "low energy", and any other "low:" part as "not" before its name.
 */
function partWords({ signal, weight }: RecipeComponent): string {
    if (signal === "arousal") return weight > 0 ? "high energy" : "low energy";
    const name = signal.replace(/_/g, " ");
    return weight > 0 ? name : `not ${name}`;
}

/** The recipe's three heaviest parts, ties in the recipe's own order, as one line. */
export function stationSubtitle(recipe: Recipe): string {
    const line = recipe.components
        .map((component, order) => ({ component, order }))
        .sort((a, b) => Math.abs(b.component.weight) - Math.abs(a.component.weight) || a.order - b.order)
        .slice(0, 3)
        .map(({ component }) => partWords(component))
        .join(", ");
    return line.charAt(0).toUpperCase() + line.slice(1);
}

function checkedStations(stations: MoodStation[]): ReadonlyMap<string, MoodStation> {
    const byValue = new Map<string, MoodStation>();
    for (const station of stations) {
        if (byValue.has(station.value)) throw new Error(`Mood station ${station.value} appears twice`);
        if (station.recipe !== null && !RECIPES.has(station.recipe)) {
            throw new Error(`Mood station ${station.value}: unknown recipe ${station.recipe}`);
        }
        byValue.set(station.value, station);
    }
    return byValue;
}

export const MOOD_STATIONS = checkedStations(STATIONS);

/** The stations as the apps list them, each with its generated subtitle. */
export function moodStationList(): { value: string; name: string; description: string }[] {
    return [...MOOD_STATIONS.values()].map(({ value, name, recipe }) => ({
        value,
        name,
        description: recipe === null ? WILDCARD_SUBTITLE : stationSubtitle(RECIPES.get(recipe)!),
    }));
}
