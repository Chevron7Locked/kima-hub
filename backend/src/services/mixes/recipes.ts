/**
 * The recipe engine behind the mood mixes, mood stations and mood pages. A recipe (recipes.json) blends learned moods
 * and readings into one score per song: each component's z-score against the library statistics the mood step keeps,
 * weighted, a "low:" component counted negatively, over the sum of the weights' sizes. That score is standardised
 * again within the library, and a song is a member of the recipe when it sits at least RECIPE_LINE standard deviations
 * above the library's average and passes the recipe's literal filters. Mixes draw evenly from the members with a seed
 * per recipe, day and user; stations draw without one.
 */
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { shuffleArray } from "../../utils/shuffle";
import { MOODS, MOOD_HEADS, type Mood } from "../moods/heads";
import { READING_SQL, loadMoodState, type MoodState, type MoodStats, type Reading } from "../moods/state";
import { TRACK_LIMIT } from "./helpers";
import recipeFile from "./recipes.json";

/** A song is a member at this many library standard deviations above the average recipe score. */
export const RECIPE_LINE = 1.25;
/** Fewest songs a mix ships with; a recipe with fewer members has no mix. */
export const MIN_MIX_TRACKS = 8;
/** Songs per artist in a mix; each next cap is used only while the one before leaves fewer than MIN_MIX_TRACKS. */
const ARTIST_CAPS = [2, 3, Infinity];
/** A tempo counts toward a BPM band only on a steady beat: the tempo extractor's confidence at least this. */
export const STEADY_BEAT = 2;

/**
 * The library cannot rank its songs for this recipe: a component, the key's scale or the recipe score has no spread
 * in it. A property of the library, not a fault; callers show no mix or an empty station.
 */
export class UnrankableLibraryError extends Error {
    constructor(readonly recipeId: string, reason: string) {
        super(`[Mixes] Recipe ${recipeId}: ${reason}`);
        this.name = "UnrankableLibraryError";
    }
}

/** The readings a recipe can blend, by their names in recipes.json. */
const READING_OF = {
    arousal: "arousal",
    instrumental: "instrumental_logit",
    acoustic: "acoustic_logit",
} as const satisfies Record<string, Reading>;
type ReadingName = keyof typeof READING_OF;

/** What a component measures: a learned mood, a reading, or the key's scale (1 for minor, 0 for major). */
export type Signal = Mood | ReadingName | "minor";

const isMood = (signal: string): signal is Mood => (MOODS as readonly string[]).includes(signal);
const isReading = (signal: string): signal is ReadingName => Object.keys(READING_OF).includes(signal);

export interface RecipeComponent {
    signal: Signal;
    /** Negative for a "low:" component, which pushes away the songs high in it. */
    weight: number;
}

export interface RecipeFilters {
    /** Inclusive BPM band; a song passes when its tempo, double or half falls inside, on a steady beat. */
    bpm?: [number, number];
    /** Inclusive bounds on CLAP's instrumental probability. */
    instrumentalMax?: number;
    instrumentalMin?: number;
    /** Inclusive band of arousal's percentile rank among the recipe's eligible songs. */
    arousalPct?: [number, number];
    /** Minor keys only. */
    minor?: true;
}

export interface Recipe {
    id: string;
    name: string;
    components: RecipeComponent[];
    filters: RecipeFilters;
}

function band(value: unknown, where: string, min: number, max: number): [number, number] {
    const finite = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) {
        throw new Error(`${where} must be [low, high]`);
    }
    const [lo, hi] = value as number[];
    if (lo < min || hi > max || lo > hi) throw new Error(`${where} must have ${min} ≤ low ≤ high ≤ ${max}`);
    return [lo, hi];
}

function probability(value: unknown, where: string): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${where} must be a probability`);
    }
    return value;
}

function parseFilters(raw: unknown, where: string): RecipeFilters {
    if (raw === undefined) return {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`${where}: filters must be an object`);
    }
    const { bpm, instrumental_max, instrumental_min, arousal_pct, minor, ...rest } = raw as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) throw new Error(`${where}: unknown filter ${unknown.join(", ")}`);
    const filters: RecipeFilters = {};
    if (bpm !== undefined) filters.bpm = band(bpm, `${where}: bpm`, 0, Infinity);
    if (instrumental_max !== undefined) {
        filters.instrumentalMax = probability(instrumental_max, `${where}: instrumental_max`);
    }
    if (instrumental_min !== undefined) {
        filters.instrumentalMin = probability(instrumental_min, `${where}: instrumental_min`);
    }
    if (arousal_pct !== undefined) filters.arousalPct = band(arousal_pct, `${where}: arousal_pct`, 0, 1);
    if (minor !== undefined) {
        if (minor !== true) throw new Error(`${where}: minor must be true when present`);
        filters.minor = true;
    }
    return filters;
}

/**
 * The recipes file, checked: every id lower-case words joined by hyphens, every component a mood or a reading with a
 * positive weight and no component twice, every filter known and in range.
 */
export function parseRecipes(raw: unknown): ReadonlyMap<string, Recipe> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Recipes: not an object");
    const recipes = new Map<string, Recipe>();
    for (const [id, entry] of Object.entries(raw)) {
        const where = `Recipe ${id}`;
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
            throw new Error(`${where}: the id must be lower-case words and hyphens`);
        }
        if (typeof entry !== "object" || entry === null) throw new Error(`${where}: not an object`);
        const { name, components, filters, ...rest } = entry as Record<string, unknown>;
        const unknown = Object.keys(rest);
        if (unknown.length > 0) throw new Error(`${where}: unknown field ${unknown.join(", ")}`);
        if (typeof name !== "string" || name.length === 0) throw new Error(`${where}: no name`);
        if (typeof components !== "object" || components === null || Array.isArray(components)) {
            throw new Error(`${where}: components must be an object`);
        }
        const parsed: RecipeComponent[] = [];
        for (const [key, weight] of Object.entries(components)) {
            const low = key.startsWith("low:");
            const signal = low ? key.slice(4) : key;
            if (!isMood(signal) && !isReading(signal) && signal !== "minor") {
                throw new Error(`${where}: unknown component ${signal}`);
            }
            if (parsed.some((c) => c.signal === signal)) throw new Error(`${where}: ${signal} appears twice`);
            if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
                throw new Error(`${where}: ${key} needs a positive weight`);
            }
            parsed.push({ signal, weight: low ? -weight : weight });
        }
        if (parsed.length === 0) throw new Error(`${where}: no components`);
        recipes.set(id, { id, name, components: parsed, filters: parseFilters(filters, where) });
    }
    return recipes;
}

export const RECIPES = parseRecipes(recipeFile);

/** The recipe with this id; an unknown id is an error, never an empty mix. */
export function getRecipe(id: string): Recipe {
    const recipe = RECIPES.get(id);
    if (!recipe) throw new Error(`Unknown recipe: ${id}`);
    return recipe;
}

// A scale the key extractor did not name is no reading, not major.
const MINOR_SQL = `CASE t."keyScale" WHEN 'minor' THEN 1.0::float8 WHEN 'major' THEN 0.0::float8 END`;

function valueSql(signal: Signal): string {
    if (isMood(signal)) return `m."${signal}"::float8`;
    if (signal === "minor") return MINOR_SQL;
    return READING_SQL[READING_OF[signal]];
}

function statsOf(state: MoodState, signal: Mood | ReadingName): MoodStats | null {
    return isMood(signal) ? state.moods[signal] : state.readings[READING_OF[signal]];
}

interface Member {
    id: string;
    artistId: string;
}

/**
 * The songs the mood statistics cover, the ones every recipe and the Wildcard station draw from: scores current for the
 * sound vector and the weights, a present readable file, finished analysis. Aliases m (scores), t (track), a (album).
 */
const SCORED_SONGS = Prisma.sql`
    FROM track_moods m
    JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
    JOIN "Track" t ON t.id = m.track_id
    JOIN "Album" a ON a.id = t."albumId"
    WHERE m.weights = ${MOOD_HEADS.version} AND te.model_version = ${MOOD_HEADS.model}
      AND t."missingSince" IS NULL AND t.corrupt = false AND t."analysisStatus" = 'completed'
`;

/**
 * The recipe's score for every song it ranks, against `state`, as the common table expressions of a WITH clause:
 * `library` (the songs the statistics cover: current scores, a present readable file, finished analysis), `key_scale`,
 * `eligible` (the library songs with every reading the recipe's components and filters use; a song missing one is
 * left out of this recipe only), `spread`, and `ranked`, each eligible song with `recipe_z`, its score standardised
 * over the eligible songs (null when they all score the same). The key's scale has no stored statistics, so its mean
 * and spread are taken here, over the library songs with a key reading. The two one-row aggregates are materialized,
 * so they are computed once even where a query reads them once and the planner would otherwise recompute them for
 * every song. A component that is absent or has no spread in `state` cannot be scored against: UnrankableLibraryError.
 */
export function recipeRankingSql(recipe: Recipe, state: MoodState): Prisma.Sql {
    const { components, filters } = recipe;
    const scales = new Map<Signal, MoodStats>();
    for (const { signal } of components) {
        if (signal === "minor") continue;
        const stats = statsOf(state, signal);
        if (!stats) {
            throw new UnrankableLibraryError(recipe.id, `no song the statistics cover has the ${signal} reading`);
        }
        if (!(stats.sd > 0)) {
            throw new UnrankableLibraryError(recipe.id, `the library's ${signal} has no spread to score against`);
        }
        scales.set(signal, stats);
    }

    const values = Prisma.raw(components.map(({ signal }, i) => `${valueSql(signal)} AS c${i}`).join(", "));
    const terms = Prisma.join(
        components.map(({ signal, weight }, i) => {
            const value = Prisma.raw(`l.c${i}`);
            if (signal === "minor") return Prisma.sql`${weight}::float8 * (${value} - k.mean) / NULLIF(k.sd, 0)`;
            const { mean, sd } = scales.get(signal)!;
            return Prisma.sql`${weight}::float8 * (${value} - ${mean}::float8) / ${sd}::float8`;
        }),
        " + ",
    );
    const totalWeight = components.reduce((sum, c) => sum + Math.abs(c.weight), 0);

    const present = components.flatMap(({ signal }, i) => (isMood(signal) ? [] : [`l.c${i} IS NOT NULL`]));
    if (filters.bpm) present.push("l.bpm IS NOT NULL", "l.bpm_confidence IS NOT NULL");
    if (filters.instrumentalMax !== undefined || filters.instrumentalMin !== undefined) {
        present.push("l.instrumentalness IS NOT NULL");
    }
    if (filters.arousalPct) present.push("l.arousal IS NOT NULL");
    if (filters.minor) present.push("l.minor IS NOT NULL");

    return Prisma.sql`
        library AS (
            SELECT t.id, lower(t.title) AS title_key, a."artistId" AS artist_id, t.bpm,
                   t."bpmConfidence" AS bpm_confidence, t.arousal, t.instrumentalness,
                   ${Prisma.raw(MINOR_SQL)} AS minor, ${values}
            ${SCORED_SONGS}
        ),
        key_scale AS MATERIALIZED (
            SELECT avg(minor) AS mean, stddev_pop(minor) AS sd FROM library
        ),
        eligible AS (
            SELECT l.*, (${terms}) / ${totalWeight}::float8 AS score
            FROM library l CROSS JOIN key_scale k
            WHERE ${Prisma.raw(present.length > 0 ? present.join(" AND ") : "true")}
        ),
        spread AS MATERIALIZED (
            SELECT count(*)::int AS eligible, avg(score) AS mean, stddev_pop(score) AS sd FROM eligible
        ),
        ranked AS (
            SELECT e.*, (e.score - s.mean) / NULLIF(s.sd, 0) AS recipe_z
            FROM eligible e CROSS JOIN spread s
        )
    `;
}

/**
 * The recipe's members through its filters, one per title (any case) and artist: the copy furthest above the line.
 * Null when the library has no mood statistics yet or fewer than MIN_MIX_TRACKS songs it could score.
 */
async function recipeMembers(recipe: Recipe): Promise<Member[] | null> {
    const state = await loadMoodState();
    if (!state || state.trackCount < MIN_MIX_TRACKS) return null;
    const { components, filters } = recipe;
    const ranking = recipeRankingSql(recipe, state);

    const passes = [Prisma.sql`r.recipe_z >= ${RECIPE_LINE}::float8`];
    if (filters.bpm) {
        const [lo, hi] = filters.bpm;
        passes.push(Prisma.sql`r.bpm_confidence >= ${STEADY_BEAT}::float8 AND (
            r.bpm BETWEEN ${lo}::float8 AND ${hi}::float8
            OR r.bpm * 2 BETWEEN ${lo}::float8 AND ${hi}::float8
            OR r.bpm / 2 BETWEEN ${lo}::float8 AND ${hi}::float8)`);
    }
    if (filters.instrumentalMax !== undefined) {
        passes.push(Prisma.sql`r.instrumentalness <= ${filters.instrumentalMax}::float8`);
    }
    if (filters.instrumentalMin !== undefined) {
        passes.push(Prisma.sql`r.instrumentalness >= ${filters.instrumentalMin}::float8`);
    }
    if (filters.arousalPct) {
        const [lo, hi] = filters.arousalPct;
        passes.push(Prisma.sql`r.arousal_pct BETWEEN ${lo}::float8 AND ${hi}::float8`);
    }
    if (filters.minor) passes.push(Prisma.sql`r.minor = 1`);
    // Over every eligible song, before any filter.
    const percentile = filters.arousalPct
        ? Prisma.sql`percent_rank() OVER (ORDER BY r.arousal)`
        : Prisma.sql`NULL::float8`;

    const rows = await prisma.$queryRaw<
        Array<{
            eligible: number;
            score_sd: number | null;
            minor_sd: number | null;
            id: string | null;
            artist_id: string | null;
        }>
    >`
        WITH ${ranking},
        placed AS (
            SELECT r.*, ${percentile} AS arousal_pct FROM ranked r
        ),
        members AS (
            SELECT DISTINCT ON (r.title_key, r.artist_id) r.id, r.artist_id
            FROM placed r
            WHERE ${Prisma.join(passes, " AND ")}
            ORDER BY r.title_key, r.artist_id, r.recipe_z DESC, r.id
        )
        SELECT s.eligible, s.sd AS score_sd, k.sd AS minor_sd, mb.id, mb.artist_id
        FROM spread s CROSS JOIN key_scale k LEFT JOIN members mb ON true
        ORDER BY mb.id
    `;
    const [summary] = rows;
    if (summary.eligible < MIN_MIX_TRACKS) return null;
    if (components.some((c) => c.signal === "minor") && !((summary.minor_sd ?? 0) > 0)) {
        throw new UnrankableLibraryError(recipe.id, "the library's key scale has no spread to score against");
    }
    if (!((summary.score_sd ?? 0) > 0)) {
        throw new UnrankableLibraryError(recipe.id, "every eligible song has the same score, so none stands out");
    }
    return rows.flatMap((r) => (r.id !== null && r.artist_id !== null ? [{ id: r.id, artistId: r.artist_id }] : []));
}

/**
 * Up to `limit` of `members`, each with an equal chance, in an order fixed by `seed`: every member is ranked by a hash
 * of the seed and its id, so one seed always draws the same songs and a member added later leaves the others' order
 * alone. At most 2 songs per artist; while that leaves fewer than MIN_MIX_TRACKS (or than `limit`, if smaller), the cap
 * rises to 3, then lifts.
 */
export function drawMembers(members: Member[], seed: string, limit: number): string[] {
    const ranked = members
        .map((member) => ({
            ...member,
            key: crypto.createHash("sha256").update(`${seed}\0${member.id}`).digest("hex"),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let picked: string[] = [];
    for (const cap of ARTIST_CAPS) {
        const perArtist = new Map<string, number>();
        picked = [];
        for (const { id, artistId } of ranked) {
            if (picked.length === limit) break;
            const count = perArtist.get(artistId) ?? 0;
            if (count >= cap) continue;
            perArtist.set(artistId, count + 1);
            picked.push(id);
        }
        // A draw asked for fewer than MIN_MIX_TRACKS (a short mood page) keeps its cap once it has them all.
        if (picked.length >= Math.min(limit, MIN_MIX_TRACKS)) break;
    }
    return picked;
}

export interface RecipeMix {
    /** The drawn songs, in draw order. */
    trackIds: string[];
    /** How many songs the draw was taken from: the members through the filters, one per title and artist. */
    members: number;
}

/**
 * A mix's songs: up to `limit` drawn evenly from the recipe's members, the same draw for one recipe, day and user.
 * Null when fewer than MIN_MIX_TRACKS songs are members; with fewer than `limit` the mix ships short. `date` is the
 * day the mix holds for, or anything that stands for a reroll.
 */
export async function pickMixTracks(
    recipe: Recipe,
    { userId, date, limit = TRACK_LIMIT }: { userId: string; date: string; limit?: number },
): Promise<RecipeMix | null> {
    if (!userId) throw new Error(`Recipe ${recipe.id}: a mix is drawn for a user`);
    if (!date) throw new Error(`Recipe ${recipe.id}: a mix is drawn for a day`);
    if (!Number.isInteger(limit) || limit < MIN_MIX_TRACKS) {
        throw new RangeError(`A mix holds at least ${MIN_MIX_TRACKS} songs; limit ${limit} cannot make one`);
    }
    const members = await recipeMembers(recipe);
    if (!members || members.length < MIN_MIX_TRACKS) return null;
    const seed = JSON.stringify([recipe.id, date, userId]);
    return { trackIds: drawMembers(members, seed, limit), members: members.length };
}

/** pickMixTracks for the shipped recipe with this id. */
export async function pickRecipeTracks(
    recipeId: string,
    options: { userId: string; date: string; limit?: number },
): Promise<RecipeMix | null> {
    return pickMixTracks(getRecipe(recipeId), options);
}

/**
 * A mood page's mix: up to `limit` drawn evenly from the recipe's members in a fresh order, with the mix's artist cap,
 * skipping `exclude` (the songs this listener was already served) while at least MIN_MIX_TRACKS others remain. Null
 * when fewer than MIN_MIX_TRACKS songs are members.
 */
export async function pickPageTracks(
    recipe: Recipe,
    { limit, exclude = [] }: { limit: number; exclude?: string[] },
): Promise<string[] | null> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
    const members = await recipeMembers(recipe);
    if (!members || members.length < MIN_MIX_TRACKS) return null;
    const served = new Set(exclude);
    const fresh = members.filter((m) => !served.has(m.id));
    return drawMembers(fresh.length >= MIN_MIX_TRACKS ? fresh : members, crypto.randomUUID(), limit);
}

/** A station's refill: up to `limit` of the recipe's members in a fresh random order; empty when it has none. */
export async function pickStationTracks(recipe: Recipe, { limit }: { limit: number }): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
    const members = await recipeMembers(recipe);
    return members ? shuffleArray(members.map((m) => m.id)).slice(0, limit) : [];
}

/**
 * The Wildcard station's refill: the songs no learned mood claims, every mood under RECIPE_LINE standard deviations
 * above the library's mean (the songs without a single mood tag), from the same songs every recipe draws from. Up to
 * `limit` in a fresh random order, one title by one artist once; empty before the mood step has built statistics. A
 * mood with no spread in the library claims no one.
 */
export async function pickWildcardStation({ limit }: { limit: number }): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
    const state = await loadMoodState();
    if (!state) return [];
    const claims = MOODS.filter((mood) => state.moods[mood].sd > 0);
    const unclaimed = claims.length
        ? Prisma.join(
              claims.map((mood) => {
                  const { mean, sd } = state.moods[mood];
                  return Prisma.sql`(${Prisma.raw(`m."${mood}"`)}::float8 - ${mean}::float8) / ${sd}::float8 < ${RECIPE_LINE}::float8`;
              }),
              " AND ",
          )
        : Prisma.sql`true`;
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM (
            SELECT DISTINCT ON (lower(t.title), a."artistId") t.id
            ${SCORED_SONGS}
              AND ${unclaimed}
            ORDER BY lower(t.title), a."artistId", t.id
        ) unclaimed
        ORDER BY random()
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/** pickStationTracks for the shipped recipe with this id. */
export async function pickRecipeStation(recipeId: string, options: { limit: number }): Promise<string[]> {
    return pickStationTracks(getRecipe(recipeId), options);
}
