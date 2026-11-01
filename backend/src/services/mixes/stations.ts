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
    /** The recipe the station plays; none for Wildcard. For a personal station, the one it falls back to. */
    recipe: string | null;
    /**
     * Set on a station whose songs come from the listener's own plays instead of the recipe (nightPlays.ts): the
     * recipe is only its cold-start fallback, so the subtitle says what the station really is.
     */
    personal?: { kind: "night"; description: string };
}

/** The stations in their approved order; five share their mix's recipe. */
const STATIONS: MoodStation[] = [
    { value: "calm", name: "Calm", recipe: "calm-station" },
    { value: "energy", name: "Energy", recipe: "energy-station" },
    { value: "intense", name: "Intense", recipe: "intense-station" },
    { value: "happy", name: "Happy", recipe: "happy" },
    { value: "melancholy", name: "Melancholy", recipe: "melancholy-station" },
    { value: "focus-calm", name: "Focus: Calm", recipe: "focus-calm-station" },
    { value: "focus-energy", name: "Focus: Energy", recipe: "focus-energy-station" },
    { value: "feel-good", name: "Feel-good", recipe: "feel-good-station" },
    { value: "late-night", name: "Late Night", recipe: "late-night" },
    { value: "romantic", name: "Romantic", recipe: "romantic-station" },
    { value: "road-trip", name: "Road Trip", recipe: "road-trip" },
    { value: "nostalgic", name: "Nostalgic", recipe: "nostalgic" },
    { value: "epic", name: "Epic", recipe: "epic" },
    { value: "wildcard", name: "Wildcard", recipe: null },
];

/** The stations whose songs come from the listener's own plays, by value (see MoodStation.personal). */
const PERSONAL: Record<string, NonNullable<MoodStation["personal"]>> = {
    "late-night": { kind: "night", description: "The songs you play after dark, and songs like them" },
};

const WILDCARD_SUBTITLE = "Songs with no mood tag";

/**
 * A part the subtitle names: what the recipe leans toward, not what it pushes away, so a "low:" part
 * is left out, except arousal, the felt-energy reading, which reads either way.
 */
const named = ({ signal, weight }: RecipeComponent): boolean => weight > 0 || signal === "arousal";

/** A part as its recipe names it, underscores read as spaces; arousal as "high energy" or "low energy". */
function partWords({ signal, weight }: RecipeComponent): string {
    if (signal === "arousal") return weight > 0 ? "high energy" : "low energy";
    return signal.replace(/_/g, " ");
}

/** The recipe's three heaviest named parts, ties in the recipe's own order, as one line. */
export function stationSubtitle(recipe: Recipe): string {
    const line = recipe.components
        .map((component, order) => ({ component, order }))
        .filter(({ component }) => named(component))
        .sort((a, b) => Math.abs(b.component.weight) - Math.abs(a.component.weight) || a.order - b.order)
        .slice(0, 3)
        .map(({ component }) => partWords(component))
        .join(", ");
    if (line.length === 0) throw new Error(`Recipe ${recipe.id}: no part leans toward anything, so no subtitle`);
    return line.charAt(0).toUpperCase() + line.slice(1);
}

function checkedStations(stations: MoodStation[]): ReadonlyMap<string, MoodStation> {
    const byValue = new Map<string, MoodStation>();
    for (const station of stations) {
        if (byValue.has(station.value)) throw new Error(`Mood station ${station.value} appears twice`);
        if (station.recipe !== null) {
            const recipe = RECIPES.get(station.recipe);
            if (!recipe) throw new Error(`Mood station ${station.value}: unknown recipe ${station.recipe}`);
            stationSubtitle(recipe);
        }
        byValue.set(station.value, { ...station, ...(PERSONAL[station.value] ? { personal: PERSONAL[station.value] } : {}) });
    }
    return byValue;
}

export const MOOD_STATIONS = checkedStations(STATIONS);

/** Station values that no longer exist (Summer; the 3AM Thoughts and Friday Night mixes' stations). */
const RETIRED_STATIONS: ReadonlySet<string> = new Set(["summer", "3am-thoughts", "friday-night"]);
/** Old values that now name another station: Focus split into Focus: Calm and Focus: Energy. */
const STATION_ALIASES: ReadonlyMap<string, string> = new Map([["focus", "focus-calm"]]);

/**
 * What an app's station value names, as the radio route needs it. A retired station is its own answer, so the route can
 * reply with an empty list instead of an error and an older app that still lists it shows an empty station.
 */
export type StationLookup =
    | { kind: "station"; value: string; station: MoodStation }
    | { kind: "retired"; value: string }
    | { kind: "unknown"; value: string };

/** The station an app's value names: read in lower case, with an old renamed value (focus) naming its successor. */
export function resolveMoodStation(requested: string): StationLookup {
    const lower = requested.toLowerCase();
    const value = STATION_ALIASES.get(lower) ?? lower;
    if (RETIRED_STATIONS.has(value)) return { kind: "retired", value };
    const station = MOOD_STATIONS.get(value);
    return station ? { kind: "station", value, station } : { kind: "unknown", value };
}

/** The stations as the apps list them, each with its generated subtitle. */
export function moodStationList(): { value: string; name: string; description: string }[] {
    return [...MOOD_STATIONS.values()].map(({ value, name, recipe, personal }) => ({
        value,
        name,
        description: personal ? personal.description : recipe === null ? WILDCARD_SUBTITLE : stationSubtitle(RECIPES.get(recipe)!),
    }));
}
