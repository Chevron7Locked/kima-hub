/**
 * AI playlist generation: the VibeQuery contract.
 *
 * A VibeQuery is a set of explicit selection parameters (feel targets, genres,
 * era, length). The LLM only translates a free-text prompt into these
 * parameters and never picks tracks (the "control principle" of #240: the
 * AI's output is shown to the user and editable before anything is applied).
 * Track selection is deterministic SQL in resolver.ts.
 */
import { prisma } from "../../utils/db";
import { z } from "zod";
import { UserFacingError } from "../../utils/errors";

export const VIBE_QUERY_LIMITS = {
    minLength: 1,
    /** Hard ceiling for a single generation (the settings guardrail can only lower it). */
    maxRequestLength: 500,
    defaultLength: 50,
    minTolerance: 0.25,
    maxTolerance: 3,
    /** Default distance from the feel target, in std-devs of the library's feel distribution. */
    defaultTolerance: 1.5,
    minYear: 1900,
    maxYear: 2100,
    maxGenreTerms: 32,
} as const;

/** The fields a VibeQuery may carry. The LLM is only allowed to fill these. */
export const VIBE_QUERY_FIELDS = [
    "valenceTarget",
    "arousalTarget",
    "feelTolerance",
    "genreIncludes",
    "genreExcludes",
    "eraFrom",
    "eraTo",
    "length",
] as const;

/** The fully normalized parameter set — the only shape the resolver accepts. */
export interface NormalizedVibeQuery {
    valenceTarget?: number;
    arousalTarget?: number;
    /** Distance from the feel target allowed, in std-devs (0.25–3, default 1.5). */
    feelTolerance: number;
    /** Lowercased, deduped; matched case-insensitively against library genre names. */
    genreIncludes: string[];
    genreExcludes: string[];
    eraFrom?: number;
    eraTo?: number;
    /** Clamped to min(1, settings.aiMaxPlaylistSize). */
    length: number;
}

const vibeQueryBase = z.object({
    valenceTarget: z.number().min(0).max(1).optional(),
    arousalTarget: z.number().min(0).max(1).optional(),
    feelTolerance: z
        .number()
        .min(VIBE_QUERY_LIMITS.minTolerance)
        .max(VIBE_QUERY_LIMITS.maxTolerance)
        .optional(),
    genreIncludes: z
        .array(z.string().trim().min(1).max(80))
        .max(VIBE_QUERY_LIMITS.maxGenreTerms)
        .optional(),
    genreExcludes: z
        .array(z.string().trim().min(1).max(80))
        .max(VIBE_QUERY_LIMITS.maxGenreTerms)
        .optional(),
    eraFrom: z
        .number()
        .int()
        .min(VIBE_QUERY_LIMITS.minYear)
        .max(VIBE_QUERY_LIMITS.maxYear)
        .optional(),
    eraTo: z
        .number()
        .int()
        .min(VIBE_QUERY_LIMITS.minYear)
        .max(VIBE_QUERY_LIMITS.maxYear)
        .optional(),
    length: z
        .number()
        .int()
        .min(1)
        .max(VIBE_QUERY_LIMITS.maxRequestLength)
        .optional(),
});

/**
 * Parse + normalize a raw query (from the LLM, or from user editing in the UI)
 * into the strict shape the resolver accepts.
 *
 * @param strict true for user-typed input (unknown fields are a 400), false for
 *               LLM output (unknown fields are dropped — models add noise).
 */
export function normalizeVibeQuery(
    raw: Record<string, unknown>,
    guardrails: { maxPlaylistSize: number },
    opts: { strict?: boolean } = {},
): NormalizedVibeQuery {
    const schema = (opts.strict ?? true)
        ? vibeQueryBase.strict()
        : vibeQueryBase.passthrough();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
            .join("; ");
        throw new UserFacingError(
            `Invalid AI playlist query — ${issues}`,
            400,
            "AI_QUERY_INVALID",
        );
    }
    const q = parsed.data;

    const hasAnchor =
        q.valenceTarget !== undefined ||
        q.arousalTarget !== undefined ||
        (q.genreIncludes?.length ?? 0) > 0 ||
        q.eraFrom !== undefined ||
        q.eraTo !== undefined;
    if (!hasAnchor) {
        throw new UserFacingError(
            "Invalid AI playlist query — at least one selection anchor is required (feel target, genre, or era).",
            400,
            "AI_QUERY_INVALID",
        );
    }

    let { eraFrom, eraTo } = q;
    if (eraFrom !== undefined && eraTo !== undefined && eraFrom > eraTo) {
        [eraFrom, eraTo] = [eraTo, eraFrom];
    }

    return {
        valenceTarget: q.valenceTarget,
        arousalTarget: q.arousalTarget,
        feelTolerance: q.feelTolerance ?? VIBE_QUERY_LIMITS.defaultTolerance,
        genreIncludes: dedupLower(q.genreIncludes),
        genreExcludes: dedupLower(q.genreExcludes),
        eraFrom,
        eraTo,
        length: Math.min(
            q.length ?? VIBE_QUERY_LIMITS.defaultLength,
            Math.max(1, guardrails.maxPlaylistSize),
        ),
    };
}

/** Case-insensitive dedup of a term list (kept lowercase: the SQL side matches with `lower(g.name)`). */
export function dedupLower(list: string[] | undefined): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const term of list ?? []) {
        const key = term.trim().toLowerCase();
        if (key.length > 0 && !seen.has(key)) {
            seen.add(key);
            out.push(key);
        }
    }
    return out;
}

/**
 * The metadata-only library outline — the only thing an AI provider ever sees:
 * the genre names that exist in the collection (with track counts, so the model
 * can only reference what is actually present) plus the range of album release
 * years. No track/album titles, no artist names, no file paths.
 */
export interface LibraryContext {
    /** Most frequent genres with track counts (top 60). */
    genres: { name: string; tracks: number }[];
    yearRange: [number, number] | null;
}

export async function buildLibraryContext(): Promise<LibraryContext> {
    const [genres, year] = await Promise.all([
        prisma.$queryRaw<{ name: string; tracks: number }[]>`
            SELECT g.name AS name, count(*)::int AS tracks
            FROM "Genre" g
            JOIN "TrackGenre" tg ON tg."genreId" = g.id
            GROUP BY g.name
            ORDER BY tracks DESC, g.name ASC
            LIMIT 60
        `,
        prisma.$queryRaw<{ min: number | null; max: number | null }[]>`
            SELECT min("year") AS min, max("year") AS max
            FROM "Album"
            WHERE "year" IS NOT NULL
        `,
    ]);
    const range = year[0];
    return {
        genres,
        yearRange:
            range && range.min != null && range.max != null
                ? [range.min, range.max]
                : null,
    };
}

/** Render the outline as the "library" block of the translation prompt. */
export function formatLibraryContext(context: LibraryContext): string {
    const lines: string[] = [];
    lines.push("Genres that exist in this library (name: number of tracks):");
    if (context.genres.length === 0) {
        lines.push("  (none)");
    } else {
        for (const g of context.genres) lines.push(`  - ${g.name}: ${g.tracks}`);
    }
    lines.push(
        context.yearRange
            ? `Album release years present: ${context.yearRange[0]} to ${context.yearRange[1]}`
            : "Album release years present: unknown",
    );
    return lines.join("\n");
}
