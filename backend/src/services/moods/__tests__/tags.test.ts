/**
 * The tag pass is skipped while the mood statistics row is the one it last wrote from (tags.ts), which is safe only if
 * every input the tags read changes that row. The inputs fingerprint (state.ts inputsFingerprint) covers the scores,
 * the eligible songs and the arousal, instrumental and acoustic readings; tempo, its confidence and the key's scale are
 * left out on purpose, as they do not move the statistics. So the focus recipe, which the focus tag reads, may use only
 * fingerprinted inputs: with a tempo or key component or filter, a re-analysis that changed only those would keep stale
 * focus tags.
 */
import { MOODS } from "../heads";
import { FOCUS_RECIPE } from "../tags";
import { getRecipe, parseRecipes, type Recipe } from "../../mixes/recipes";
import recipeFile from "../../mixes/recipes.json";

/** Components whose input the fingerprint covers: every mood score, and the three readings it hashes. */
const FINGERPRINTED_SIGNALS = new Set<string>([...MOODS, "arousal", "instrumental", "acoustic"]);
/** Filters whose input it covers: the arousal band (arousal) and the instrumental bounds (instrumentalness). */
const FINGERPRINTED_FILTERS = new Set<string>(["arousalPct", "instrumentalMin", "instrumentalMax"]);

/** The components and filters of `recipe` that read an input the fingerprint does not cover. */
function unfingerprinted(recipe: Recipe): string[] {
    return [
        ...recipe.components.map((c) => c.signal).filter((signal) => !FINGERPRINTED_SIGNALS.has(signal)),
        ...Object.keys(recipe.filters).filter((filter) => !FINGERPRINTED_FILTERS.has(filter)),
    ];
}

/** The shipped focus recipe with `change` applied to a copy of its entry in recipes.json. */
function focusCopy(change: (entry: { components: Record<string, number>; filters: Record<string, unknown> }) => void) {
    const entry = JSON.parse(JSON.stringify((recipeFile as Record<string, unknown>)[FOCUS_RECIPE]));
    entry.filters ??= {};
    change(entry);
    return parseRecipes({ [FOCUS_RECIPE]: entry }).get(FOCUS_RECIPE)!;
}

describe("the focus tag's inputs", () => {
    it("are all in the mood statistics' inputs fingerprint, so skipping an unchanged tag pass is safe", () => {
        expect(unfingerprinted(getRecipe(FOCUS_RECIPE))).toEqual([]);
    });

    it("would not be, with a tempo filter or a key component in the focus recipe", () => {
        expect(unfingerprinted(focusCopy((e) => (e.filters.bpm = [60, 90])))).toEqual(["bpm"]);
        expect(unfingerprinted(focusCopy((e) => (e.filters.minor = true)))).toEqual(["minor"]);
        expect(unfingerprinted(focusCopy((e) => (e.components.minor = 1)))).toEqual(["minor"]);
    });
});
