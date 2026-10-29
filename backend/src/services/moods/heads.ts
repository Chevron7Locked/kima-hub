/**
 * The learned moods' weights (moodHeads.json, generated from the trained mood models). Each mood's
 * standardisation is folded into its weights and bias, so its score for a sound vector is one dot product:
 * the logit of that mood's model.
 */
import moodHeads from "./moodHeads.json";

/** The moods, in the file's order; each is a column of track_moods and a pair of columns of mood_state. */
export const MOODS = [
    "happy", "fun_quirky", "uplifting", "sad", "nostalgic", "dark", "trippy", "calm", "dreamy", "energetic",
    "aggressive", "epic", "party", "groovy", "romantic", "sexy", "summer", "night", "driving", "workout", "focus",
    "sleep",
] as const;

export type Mood = (typeof MOODS)[number];

/**
 * Moods the heads still score (moodHeads.json and the stored scores and statistics are unchanged, so nothing is
 * retrained) that no tag, recipe or definition may use. Night is each person's own night plays now, not a sound
 * (mixes/nightPlays.ts).
 */
export const RETIRED_MOODS: readonly Mood[] = ["night"];

/** The moods a recipe, a definition or a tag may use: every learned mood but the retired ones. */
export const LIVE_MOODS: readonly Mood[] = MOODS.filter((mood) => !RETIRED_MOODS.includes(mood));

export interface MoodHead {
    weights: number[];
    bias: number;
}

export interface MoodHeads {
    /** Identifies the weights; stored with every score so a new file rescores every track. */
    version: string;
    /** The sound model the moods were fitted on; vectors from any other model are not scored. */
    model: string;
    dims: number;
    heads: Record<Mood, MoodHead>;
}

/** The weights file, checked: every mood present in order, each with `dims` finite weights and a finite bias. */
export function parseMoodHeads(raw: unknown): MoodHeads {
    const file = raw as {
        version?: unknown;
        model?: unknown;
        dims?: unknown;
        order?: unknown;
        moods?: Record<string, { w?: unknown; b?: unknown }>;
    };
    if (typeof file?.version !== "string" || file.version.length === 0) throw new Error("Mood weights: no version");
    if (typeof file.model !== "string" || file.model.length === 0) throw new Error("Mood weights: no model");
    const dims = file.dims;
    if (typeof dims !== "number" || !Number.isInteger(dims) || dims <= 0) throw new Error("Mood weights: no dims");
    const order = file.order;
    if (!Array.isArray(order) || order.length !== MOODS.length || order.some((mood, i) => mood !== MOODS[i])) {
        throw new Error(`Mood weights: order must be ${MOODS.join(", ")}`);
    }
    if (typeof file.moods !== "object" || file.moods === null) throw new Error("Mood weights: no moods");
    const extra = Object.keys(file.moods).filter((mood) => !(MOODS as readonly string[]).includes(mood));
    if (extra.length > 0) throw new Error(`Mood weights: moods outside the order: ${extra.join(", ")}`);
    const heads = {} as Record<Mood, MoodHead>;
    for (const mood of MOODS) {
        const head = file.moods[mood];
        if (!head) throw new Error(`Mood weights: ${mood} is missing`);
        const { w, b } = head;
        if (!Array.isArray(w) || w.length !== dims) throw new Error(`Mood weights: ${mood} needs ${dims} weights`);
        if (w.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
            throw new Error(`Mood weights: ${mood} has a weight that is not a finite number`);
        }
        if (typeof b !== "number" || !Number.isFinite(b)) throw new Error(`Mood weights: ${mood} has no finite bias`);
        heads[mood] = { weights: w as number[], bias: b };
    }
    return { version: file.version, model: file.model, dims, heads };
}

export const MOOD_HEADS = parseMoodHeads(moodHeads);
