/**
 * The recipe engine behind the mood mixes, mood stations and mood pages. A recipe (recipes.json) blends learned moods
 * and readings into one score per song: each component's z-score against the library statistics the mood step keeps,
 * weighted, a "low:" component counted negatively, over the sum of the weights' sizes. That score is standardised
 * again within the library, and a song is a member of the recipe when it sits at least RECIPE_LINE standard deviations
 * above the library's average and passes the recipe's literal filters. Mixes draw evenly from the members with a seed
 * per recipe, day and user; stations play every member, in an order that spreads each artist's songs.
 */
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { stationPage, type StationPage, type StationRequest, type StationSong } from "./stationOrder";
import { UNKNOWN_ARTIST, VARIOUS_ARTISTS_CANONICAL } from "../../utils/artistNormalization";
import { artistIdentityKey } from "../artistIdentity";
import { LIVE_MOODS, MOOD_HEADS, type Mood } from "../moods/heads";
import { READING_SQL, loadMoodState, type MoodState, type MoodStats, type Reading } from "../moods/state";
import { TRACK_LIMIT } from "./helpers";
import { familiarBoost, type FamiliarBoost } from "./familiarity";
import recipeFile from "./recipes.json";
import { DEFINITIONS, NEUTRAL_PACE, PACE_BAND, type DefinitionPart, type MoodDefinition } from "./moodDefinitions";

export type { StationPage, StationRequest };

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

const isMood = (signal: string): signal is Mood => (LIVE_MOODS as readonly string[]).includes(signal);
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
    /**
     * How much the songs that sound like this person's most-heard songs are boosted (familiarity.ts), as a share of
     * the recipe's score: the closest gain this much, in the units of the average component z-score. A boost, never a
     * filter, added after the library's scores are standardised, so a song this person never heard scores exactly as
     * it does for a person with no plays. Left out when the recipe has none.
     */
    familiarity?: number;
}

/** The familiarity boost for this listener, only for a recipe that carries a familiarity share (familiarity.ts). */
async function boostFor(recipe: Recipe, userId?: string): Promise<FamiliarBoost | null> {
    return recipe.familiarity !== undefined && userId !== undefined ? familiarBoost(userId) : null;
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
        const { name, components, filters, familiarity, ...rest } = entry as Record<string, unknown>;
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
        if (familiarity !== undefined && (typeof familiarity !== "number" || !(familiarity > 0) || familiarity > 0.5)) {
            throw new Error(`${where}: familiarity must be above 0 and at most 0.5`);
        }
        recipes.set(id, {
            id,
            name,
            components: parsed,
            filters: parseFilters(filters, where),
            ...(familiarity === undefined ? {} : { familiarity }),
        });
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

type Member = StationSong;

/**
 * The songs the mood statistics cover, the ones every recipe and the Wildcard station draw from: scores current for the
 * sound vector and the weights, a present readable file, finished analysis. Aliases m (scores), t (track), a (album),
 * ar (album artist).
 */
export const SCORED_SONGS = Prisma.sql`
    FROM track_moods m
    JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
    JOIN "Track" t ON t.id = m.track_id
    JOIN "Album" a ON a.id = t."albumId"
    JOIN "Artist" ar ON ar.id = a."artistId"
    WHERE m.weights = ${MOOD_HEADS.version} AND te.model_version = ${MOOD_HEADS.model}
      AND t."missingSince" IS NULL AND t.corrupt = false AND t."analysisStatus" = 'completed'
`;

/**
 * The identity keys of the album artist rows that name no one (artistSql). Worked out on each call, not at load, as
 * before: tests that mock artistIdentity with only artistSortName still load this module.
 */
function noOneKeys(): string[] {
    return [artistIdentityKey(VARIOUS_ARTISTS_CANONICAL), artistIdentityKey(UNKNOWN_ARTIST)];
}

/**
 * The artist a song counts toward for the per-artist cap and the one-title-per-artist rule: its album's artist, except
 * on the album artist rows that name no one, Various Artists (every spelling of it is filed under one row) and the
 * Unknown Artist the scanner falls back to, where each song counts as its own artist. So a compilation can fill a mix
 * past the cap, and two songs with one title by different performers both stay. An artist actually named "Unknown
 * Artist" shares that row and is treated the same. A stopgap until each song carries its own artist.
 */
export function artistSql(): Prisma.Sql {
    return Prisma.sql`CASE WHEN ar."identityKey" IN (${Prisma.join(noOneKeys())}) THEN 'song:' || t.id ELSE a."artistId" END`;
}

/** artistSql for a song already read: its id, its album's artist id and that artist's identity key. */
export function songArtistKey(trackId: string, albumArtistId: string, albumArtistIdentityKey: string): string {
    return noOneKeys().includes(albumArtistIdentityKey) ? `song:${trackId}` : albumArtistId;
}

// ---- mood definitions (moodDefinitions.ts) ---------------------------------------------------------------------

/** The part's input column in the library CTE (definitionInputs): one per mood, reading or the pace. */
function partColumn(part: DefinitionPart): string {
    switch (part.kind) {
        case "mood":
        case "head":
            return `dm_${part.mood}`;
        case "reading":
            return `dr_${part.reading}`;
        case "pace":
            return "dpace";
    }
}

/** The pace of a song as a value: 1 inside the band (double or half counts) on a steady beat, 0 outside, else neutral. */
export const PACE_SQL = (() => {
    const [lo, hi] = PACE_BAND;
    return `CASE WHEN t.bpm IS NULL OR t."bpmConfidence" IS NULL OR t."bpmConfidence" < ${STEADY_BEAT} THEN ${NEUTRAL_PACE}::float8
        WHEN t.bpm BETWEEN ${lo} AND ${hi} OR t.bpm * 2 BETWEEN ${lo} AND ${hi} OR t.bpm / 2 BETWEEN ${lo} AND ${hi}
        THEN 1::float8 ELSE 0::float8 END`;
})();

/** The input columns the definitions read, to append to a select over SCORED_SONGS (aliases m and t). */
export function definitionInputs(definitions: readonly MoodDefinition[]): Prisma.Sql {
    const columns = new Map<string, string>();
    for (const { parts } of definitions) {
        for (const part of parts) {
            const name = partColumn(part);
            if (columns.has(name)) continue;
            columns.set(
                name,
                part.kind === "pace"
                    ? PACE_SQL
                    : part.kind === "reading"
                      ? READING_SQL[READING_OF[part.reading]]
                      : `m."${part.mood}"::float8`,
            );
        }
    }
    return Prisma.raw([...columns].map(([name, sql]) => `${sql} AS ${name}`).join(", "));
}

const scoreColumn = (mood: Mood) => `dscore_${mood}`;

/**
 * The defined moods' scores as CTEs over `source` (a relation with the definitionInputs columns): `pace_scale` when a
 * definition reads pace, then `defined`, each source row with a `dscore_<mood>`: the weights times the parts' library
 * z-scores, over the sum of the weights' sizes, NULL for a song missing a reading it reads. A part's z-score is
 * against the statistics of `state`, the pace's against the library's own (a library whose songs all have the same
 * pace, as one with no tempo readings, reads every pace as the average). `extra` is more columns for `defined`.
 * Throws UnrankableLibraryError for a part without a usable scale.
 */
export function definedCtes(
    recipeId: string,
    state: MoodState,
    definitions: readonly MoodDefinition[],
    source: string,
    extra: { columns?: Prisma.Sql; joins?: Prisma.Sql } = {},
): Prisma.Sql {
    const usesPace = definitions.some((d) => d.parts.some((p) => p.kind === "pace"));
    const scores = definitions.map((definition) => {
        const terms = definition.parts.map((part) => {
            const column = Prisma.raw(`l.${partColumn(part)}`);
            if (part.kind === "pace") {
                return Prisma.sql`${part.weight}::float8 * COALESCE((${column} - ps.mean) / NULLIF(ps.sd, 0), 0)`;
            }
            const stats =
                part.kind === "reading"
                    ? state.readings[READING_OF[part.reading]]
                    : state.moods[part.mood];
            const name = part.kind === "reading" ? part.reading : part.mood;
            if (!stats) {
                throw new UnrankableLibraryError(recipeId, `no song the statistics cover has the ${name} reading`);
            }
            if (!(stats.sd > 0)) {
                throw new UnrankableLibraryError(recipeId, `the library's ${name} has no spread to score against`);
            }
            return Prisma.sql`${part.weight}::float8 * (${column} - ${stats.mean}::float8) / ${stats.sd}::float8`;
        });
        const total = definition.parts.reduce((sum, p) => sum + Math.abs(p.weight), 0);
        return Prisma.sql`(${Prisma.join(terms, " + ")}) / ${total}::float8 AS ${Prisma.raw(scoreColumn(definition.mood))}`;
    });
    return Prisma.sql`
        ${usesPace ? Prisma.sql`pace_scale AS MATERIALIZED (
            SELECT avg(dpace) AS mean, stddev_pop(dpace) AS sd FROM ${Prisma.raw(source)}
        ),` : Prisma.empty}
        defined AS (
            SELECT l.*${scores.length > 0 ? Prisma.sql`, ${Prisma.join(scores)}` : Prisma.empty}${extra.columns ?? Prisma.empty}
            FROM ${Prisma.raw(source)} l ${usesPace ? Prisma.sql`CROSS JOIN pace_scale ps` : Prisma.empty} ${extra.joins ?? Prisma.empty}
        )
    `;
}

/** `def_stats` over `defined`: each defined mood's library mean (`<mood>_mean`) and population SD (`<mood>_sd`). */
export function definedStatsCte(definitions: readonly MoodDefinition[]): Prisma.Sql {
    const columns = definitions.flatMap(({ mood }) => [
        `avg(${scoreColumn(mood)}) AS ${mood}_mean`,
        `stddev_pop(${scoreColumn(mood)}) AS ${mood}_sd`,
    ]);
    return Prisma.sql`def_stats AS MATERIALIZED (SELECT ${Prisma.raw(columns.join(", "))} FROM defined)`;
}

/** The standardised defined score of `mood` for a row of `defined` (alias `row`, l unless given) against def_stats (alias ds); NULL if none. */
export function definedZSql(mood: Mood, row = "l"): string {
    return `(${row}.${scoreColumn(mood)} - ds.${mood}_mean) / NULLIF(ds.${mood}_sd, 0)`;
}

/**
 * The recipe's score for every song it ranks, against `state`, as the common table expressions of a WITH clause:
 * `library` (the songs the statistics cover: current scores, a present readable file, finished analysis), `defined`
 * (the library with the scores of the defined moods the recipe reads, and, with a familiarity `boost`, each song's
 * boost, 0 for a song it does not list), `key_scale`, `eligible` (the library songs with every reading the recipe's
 * components and filters use; a song missing one is left out of this recipe only), `spread`, `ranked`, each eligible
 * song with `recipe_z`, its score standardised over the eligible songs (null when they all score the same), and
 * `placed`, each ranked song with its arousal percentile among them and `in_filters`, whether it passes the recipe's
 * literal filters. A component whose mood has a definition reads the defined score, standardised over the library
 * songs that have one like a raw score is. The key's scale has no stored statistics, so its mean and spread are taken
 * here, over the library songs with a key reading. The one-row aggregates are materialized, so they are computed once
 * even where a query reads them once and the planner would otherwise recompute them for every song. A component that
 * is absent or has no spread in `state` cannot be scored against: UnrankableLibraryError.
 */
export function recipeRankingSql(recipe: Recipe, state: MoodState, boost?: FamiliarBoost | null): Prisma.Sql {
    const { components, filters } = recipe;
    const definitions = [
        ...new Set(components.flatMap(({ signal }) => DEFINITIONS.get(signal as Mood) ?? [])),
    ];
    const isDefined = (signal: Signal) => signal !== "minor" && DEFINITIONS.has(signal as Mood);
    const scales = new Map<Signal, MoodStats>();
    for (const { signal } of components) {
        if (signal === "minor" || isDefined(signal)) continue;
        const stats = statsOf(state, signal);
        if (!stats) {
            throw new UnrankableLibraryError(recipe.id, `no song the statistics cover has the ${signal} reading`);
        }
        if (!(stats.sd > 0)) {
            throw new UnrankableLibraryError(recipe.id, `the library's ${signal} has no spread to score against`);
        }
        scales.set(signal, stats);
    }

    const active = recipe.familiarity !== undefined && boost && boost.ids.length > 0 ? boost : null;
    const familiar = active !== null;
    const defined = definedCtes(recipe.id, state, definitions, "library", {
        columns: familiar ? Prisma.sql`, COALESCE(fb.boost, 0::float8) AS fam` : Prisma.empty,
        joins: familiar
            ? Prisma.sql`LEFT JOIN (
                SELECT * FROM unnest(${active?.ids ?? []}::text[], ${active?.boosts ?? []}::float8[]) AS u(id, boost)
            ) fb ON fb.id = l.id`
            : Prisma.empty,
    });

    const values = Prisma.raw(
        [
            ...components.map(({ signal }, i) => (isDefined(signal) ? null : `${valueSql(signal)} AS c${i}`)),
            ...(definitions.length > 0 ? [definitionInputs(definitions).sql] : []),
        ]
            .filter((v): v is string => v !== null && v.length > 0)
            .join(", ") || "NULL::float8 AS unused",
    );
    const terms = Prisma.join(
        components.map(({ signal, weight }, i) => {
            const value = Prisma.raw(`l.c${i}`);
            if (signal === "minor") return Prisma.sql`${weight}::float8 * (${value} - k.mean) / NULLIF(k.sd, 0)`;
            if (isDefined(signal)) return Prisma.sql`${weight}::float8 * ${Prisma.raw(definedZSql(signal as Mood))}`;
            const { mean, sd } = scales.get(signal)!;
            return Prisma.sql`${weight}::float8 * (${value} - ${mean}::float8) / ${sd}::float8`;
        }),
        " + ",
    );
    const totalWeight = components.reduce((sum, c) => sum + Math.abs(c.weight), 0);

    const present = components.flatMap(({ signal }, i) =>
        isDefined(signal)
            ? [`l.${scoreColumn(signal as Mood)} IS NOT NULL`]
            : isMood(signal)
              ? []
              : [`l.c${i} IS NOT NULL`],
    );
    if (filters.bpm) present.push("l.bpm IS NOT NULL", "l.bpm_confidence IS NOT NULL");
    if (filters.instrumentalMax !== undefined || filters.instrumentalMin !== undefined) {
        present.push("l.instrumentalness IS NOT NULL");
    }
    if (filters.arousalPct) present.push("l.arousal IS NOT NULL");
    if (filters.minor) present.push("l.minor IS NOT NULL");

    // The arousal percentile is taken over every eligible song, before any filter.
    const percentile = filters.arousalPct ? "percent_rank() OVER (ORDER BY r.arousal)" : "NULL::float8";
    const passes: Prisma.Sql[] = [];
    if (filters.bpm) {
        const [lo, hi] = filters.bpm;
        passes.push(Prisma.sql`p.bpm_confidence >= ${STEADY_BEAT}::float8 AND (
            p.bpm BETWEEN ${lo}::float8 AND ${hi}::float8
            OR p.bpm * 2 BETWEEN ${lo}::float8 AND ${hi}::float8
            OR p.bpm / 2 BETWEEN ${lo}::float8 AND ${hi}::float8)`);
    }
    if (filters.instrumentalMax !== undefined) {
        passes.push(Prisma.sql`p.instrumentalness <= ${filters.instrumentalMax}::float8`);
    }
    if (filters.instrumentalMin !== undefined) {
        passes.push(Prisma.sql`p.instrumentalness >= ${filters.instrumentalMin}::float8`);
    }
    if (filters.arousalPct) {
        const [lo, hi] = filters.arousalPct;
        passes.push(Prisma.sql`p.arousal_pct BETWEEN ${lo}::float8 AND ${hi}::float8`);
    }
    if (filters.minor) passes.push(Prisma.sql`p.minor = 1`);

    return Prisma.sql`
        library AS (
            SELECT t.id, lower(t.title) AS title_key, ${artistSql()} AS artist_id, t.bpm,
                   t."bpmConfidence" AS bpm_confidence, t.arousal, t.instrumentalness,
                   ${Prisma.raw(MINOR_SQL)} AS minor, ${values}
            ${SCORED_SONGS}
        ),
        ${defined},
        ${definitions.length > 0 ? Prisma.sql`${definedStatsCte(definitions)},` : Prisma.empty}
        key_scale AS MATERIALIZED (
            SELECT avg(minor) AS mean, stddev_pop(minor) AS sd FROM defined
        ),
        eligible AS (
            SELECT l.*, (${terms}) / ${totalWeight}::float8 AS score
            FROM defined l CROSS JOIN key_scale k ${definitions.length > 0 ? Prisma.sql`CROSS JOIN def_stats ds` : Prisma.empty}
            WHERE ${Prisma.raw(present.length > 0 ? present.join(" AND ") : "true")}
        ),
        spread AS MATERIALIZED (
            SELECT count(*)::int AS eligible, avg(score) AS mean, stddev_pop(score) AS sd FROM eligible
        ),
        ranked AS (
            SELECT e.*, (e.score - s.mean ${
                familiar ? Prisma.sql`+ ${recipe.familiarity!}::float8 * e.fam` : Prisma.empty
            }) / NULLIF(s.sd, 0) AS recipe_z
            FROM eligible e CROSS JOIN spread s
        ),
        placed AS (
            SELECT p.*, ${passes.length > 0 ? Prisma.join(passes, " AND ") : Prisma.sql`true`} AS in_filters
            FROM (SELECT r.*, ${Prisma.raw(percentile)} AS arousal_pct FROM ranked r) p
        )
    `;
}

/**
 * SQL true for a row of `placed` under `alias` that sits at the line: at least RECIPE_LINE above the average and
 * through the filters, in a ranking of at least MIN_MIX_TRACKS songs (a smaller one has no members). The recipe's
 * members are these, one copy per title and artist; the focus tag takes every copy (moods/tags.ts).
 */
export function atLineSql(alias: string): string {
    const ranked = `(SELECT eligible FROM spread) >= ${MIN_MIX_TRACKS}`;
    return `(${alias}.recipe_z >= ${RECIPE_LINE} AND ${alias}.in_filters AND ${ranked})`;
}

/** The members step after recipeRankingSql: the songs at the line, one per title (any case) and artist. */
const MEMBERS_SQL = Prisma.sql`
    members AS (
        SELECT DISTINCT ON (r.title_key, r.artist_id) r.id, r.artist_id
        FROM placed r
        WHERE ${Prisma.raw(atLineSql("r"))}
        ORDER BY r.title_key, r.artist_id, r.recipe_z DESC, r.id
    )
`;

interface RankingSummary {
    eligible: number;
    score_sd: number | null;
    minor_sd: number | null;
}

/** False when the recipe ranks fewer than MIN_MIX_TRACKS songs; an error when the ranking cannot set any apart. */
function ranksEnough(recipe: Recipe, summary: RankingSummary): boolean {
    if (summary.eligible < MIN_MIX_TRACKS) {
        const defined = recipe.components.filter((c) => DEFINITIONS.has(c.signal as Mood)).map((c) => c.signal);
        if (defined.length > 0) {
            logger.debug(`[Mixes] ${recipe.id}: ${summary.eligible} eligible songs; a defined mood (${defined.join(", ")}) may have no readings to score`);
        }
        return false;
    }
    if (recipe.components.some((c) => c.signal === "minor") && !((summary.minor_sd ?? 0) > 0)) {
        throw new UnrankableLibraryError(recipe.id, "the library's key scale has no spread to score against");
    }
    if (!((summary.score_sd ?? 0) > 0)) {
        throw new UnrankableLibraryError(recipe.id, "every eligible song has the same score, so none stands out");
    }
    return true;
}

/**
 * The recipe's members through its filters, one per title (any case) and artist: the copy furthest above the line.
 * Null when the library has no mood statistics yet or fewer than MIN_MIX_TRACKS songs it could score. With a `userId`,
 * a recipe that carries a familiarity boost lifts the songs that person heard more often.
 */
export async function recipeMembers(recipe: Recipe, userId?: string): Promise<Member[] | null> {
    const state = await loadMoodState();
    if (!state || state.trackCount < MIN_MIX_TRACKS) return null;
    const rows = await prisma.$queryRaw<Array<RankingSummary & { id: string | null; artist_id: string | null }>>`
        WITH ${recipeRankingSql(recipe, state, await boostFor(recipe, userId))}, ${MEMBERS_SQL}
        SELECT s.eligible, s.sd AS score_sd, k.sd AS minor_sd, mb.id, mb.artist_id
        FROM spread s CROSS JOIN key_scale k LEFT JOIN members mb ON true
        ORDER BY mb.id
    `;
    if (!ranksEnough(recipe, rows[0])) return null;
    return rows.flatMap((r) => (r.id !== null && r.artist_id !== null ? [{ id: r.id, artistId: r.artist_id }] : []));
}

/** How many members recipeMembers would return, counted in the database; null where it returns null. */
async function recipeMemberCount(recipe: Recipe, userId?: string): Promise<number | null> {
    const state = await loadMoodState();
    if (!state || state.trackCount < MIN_MIX_TRACKS) return null;
    const [summary] = await prisma.$queryRaw<Array<RankingSummary & { members: number }>>`
        WITH ${recipeRankingSql(recipe, state, await boostFor(recipe, userId))}, ${MEMBERS_SQL}
        SELECT s.eligible, s.sd AS score_sd, k.sd AS minor_sd, (SELECT count(*)::int FROM members) AS members
        FROM spread s CROSS JOIN key_scale k
    `;
    return ranksEnough(recipe, summary) ? summary.members : null;
}

/** A mood page plays its recipe only with at least MIN_MIX_TRACKS members; with fewer it has no mix. */
function pagePlays(members: number | null): members is number {
    return members !== null && members >= MIN_MIX_TRACKS;
}

/**
 * Up to `limit` of `members`, each with an equal chance, in an order fixed by `seed`: every member is ranked by a hash
 * of the seed and its id, so one seed always draws the same songs and a member added later leaves the others' order
 * alone. At most 2 songs per artist; while that leaves fewer than MIN_MIX_TRACKS (or than `limit`, if smaller), the cap
 * rises to 3, then lifts.
 */
export function drawMembers(members: Member[], seed: string, limit: number): string[] {
    return capByArtist(seededOrder(members, seed), limit);
}

/** Every member in the order `seed` fixes (a hash of the seed and its id), with no artist cap. */
export function seededOrder<T extends Member>(members: T[], seed: string): T[] {
    return members
        .map((member) => ({
            member,
            key: crypto.createHash("sha256").update(`${seed}\0${member.id}`).digest("hex"),
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(({ member }) => member);
}

/**
 * The first `limit` of `ordered`, in that order, with drawMembers's artist cap: at most 2 per artist; while that
 * leaves fewer than MIN_MIX_TRACKS (or than `limit`, if smaller), 3, then no cap.
 */
export function capByArtist(ordered: Member[], limit: number): string[] {
    let picked: string[] = [];
    for (const cap of ARTIST_CAPS) {
        const perArtist = new Map<string, number>();
        picked = [];
        for (const { id, artistId } of ordered) {
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
    const members = await recipeMembers(recipe, userId);
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
    { limit, exclude = [], userId }: { limit: number; exclude?: string[]; userId?: string },
): Promise<string[] | null> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`limit must be a positive integer, got ${limit}`);
    const members = await recipeMembers(recipe, userId);
    if (!members || !pagePlays(members.length)) return null;
    const served = new Set(exclude);
    const fresh = members.filter((m) => !served.has(m.id));
    return drawMembers(fresh.length >= MIN_MIX_TRACKS ? fresh : members, crypto.randomUUID(), limit);
}

/** How many songs a mood page draws from: the recipe's members, or 0 when the page has no mix (pickPageTracks). */
export async function pageMemberCount(recipe: Recipe, userId?: string): Promise<number> {
    const members = await recipeMemberCount(recipe, userId);
    return pagePlays(members) ? members : 0;
}

/** A station's refill from the recipe's members (stationPage); no songs when it has none. */
export async function pickStationPage(recipe: Recipe, request: StationRequest): Promise<StationPage> {
    return stationPage(`recipe:${recipe.id}`, () => recipeMembers(recipe, request.listener), request);
}

/** pickStationPage's songs. */
export async function pickStationTracks(recipe: Recipe, request: StationRequest): Promise<string[]> {
    return (await pickStationPage(recipe, request)).trackIds;
}

/**
 * The Wildcard station's refill: the songs without a single mood tag, from the same songs every recipe draws from. It
 * reads the tags the mood step wrote (tags.ts) instead of repeating their rule, so it is always the songs shown
 * untagged, focus tagged by the Focus Mix recipe included, and it keeps playing them while the statistics are rebuilt,
 * as the tags are kept then. One title by one artist once, refilled as any station (stationPage); no songs before the
 * mood step has scored one.
 */
export async function pickWildcardPage(request: StationRequest): Promise<StationPage> {
    return stationPage("wildcard", async () => {
        const rows = await prisma.$queryRaw<Array<{ id: string; artist_key: string }>>`
            SELECT id, artist_key FROM (
                SELECT DISTINCT ON (s.title_key, s.artist_key) s.id, s.artist_key
                FROM (
                    SELECT t.id, lower(t.title) AS title_key, ${artistSql()} AS artist_key
                    ${SCORED_SONGS}
                      AND COALESCE(cardinality(t."moodTags"), 0) = 0
                ) s
                ORDER BY s.title_key, s.artist_key, s.id
            ) untagged
            ORDER BY id
        `;
        return rows.map((r) => ({ id: r.id, artistId: r.artist_key }));
    }, request);
}

/** pickWildcardPage's songs. */
export async function pickWildcardStation(request: StationRequest): Promise<string[]> {
    return (await pickWildcardPage(request)).trackIds;
}

/** pickStationTracks for the shipped recipe with this id. */
export async function pickRecipeStation(recipeId: string, options: StationRequest): Promise<string[]> {
    return pickStationTracks(getRecipe(recipeId), options);
}

/** pickStationPage for the shipped recipe with this id. */
export async function pickRecipeStationPage(recipeId: string, options: StationRequest): Promise<StationPage> {
    return pickStationPage(getRecipe(recipeId), options);
}
