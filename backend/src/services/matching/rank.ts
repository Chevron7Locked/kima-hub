/**
 * The ranking pass every vibe feature uses: the library scored against a weighted set
 * of input tracks with the 1.11 formula, `Σ_i w_i · s(t, i)`, in one exact scan. Eligible tracks have a sound vector of the
 * probe's model, current feel, and a present file.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { formatEmbedding, parseEmbedding } from "../../utils/embedding";
import {
    FEEL_WEIGHT,
    MAX_PER_ALBUM,
    MAX_PER_ARTIST,
    artistBonuses,
    blendSoundFeel,
    dot,
    feelVector,
    unit,
    type ArtistProfile,
    type MatchTrack,
    type WeightedTrack,
} from "./formula";
import { MATCHING_MODEL, PROBE_ID, loadMatchingState, type MatchingState } from "./state";

export interface LibraryTrack {
    id: string;
    title: string;
    /** Seconds. */
    duration: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

export interface RankedTrack extends LibraryTrack {
    score: number;
}

export interface WeightedInput {
    trackId: string;
    weight: number;
}

/** A track that takes one of the places its album and artist are allowed. */
export interface Counted {
    albumId: string;
    artistId: string;
}

export interface MatchingContext {
    state: MatchingState;
    /** The requested tracks that have current matching data. */
    tracks: Map<string, MatchTrack>;
}

interface InputRow {
    id: string;
    albumId: string;
    artistId: string;
    embedding: string;
    valence: number;
    arousal: number;
}

interface ScoredIds {
    id: string;
    albumId: string;
    artistId: string;
    [score: `s${number}`]: number;
}

interface ProfileRow {
    artistId: string;
    sound: string;
    v: number;
    a: number;
}

const FEEL_SQ = FEEL_WEIGHT * FEEL_WEIGHT;

const TRACK_COLUMNS = Prisma.sql`t.id, t.title, t.duration,
    a.id AS "albumId", a.title AS "albumTitle", a."coverUrl" AS "albumCoverUrl",
    ar.id AS "artistId", ar.name AS "artistName"`;

/** The library's state and the named tracks' matching data; null until a state is built. */
export async function matchingContext(trackIds: string[]): Promise<MatchingContext | null> {
    const state = await loadMatchingState();
    if (!state) return null;
    const rows = await prisma.$queryRaw<InputRow[]>`
        SELECT te.track_id AS id, t."albumId", a."artistId", te.embedding::text AS embedding, f.valence, f.arousal
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        WHERE te.track_id = ANY(${trackIds}) AND te.model_version = ${MATCHING_MODEL}
    `;
    const tracks = new Map<string, MatchTrack>();
    for (const r of rows) {
        tracks.set(r.id, {
            trackId: r.id,
            albumId: r.albumId,
            artistId: r.artistId,
            sound: unit(parseEmbedding(r.embedding)),
            feel: feelVector([r.valence, r.arousal], state.feel),
        });
    }
    return { state, tracks };
}

export function weightedTracks(ctx: MatchingContext, inputs: WeightedInput[]): WeightedTrack[] {
    return inputs.map(({ trackId, weight }) => {
        const track = ctx.tracks.get(trackId);
        if (!track) throw new Error(`No matching data for track ${trackId}`);
        return { track, weight };
    });
}

/**
 * One input set's score for the row in scope: the sound term against `Σ w ĉ`, the
 * feel term against `Σ w v` (v rebuilt from stored feel and the library's mean and
 * SD), and the artist bonus read from `bonus`.
 */
function scoreSql(inputs: WeightedTrack[], bonus: Prisma.Sql): Prisma.Sql {
    const { sound, feel } = blendSoundFeel(inputs);
    const soundNorm = Math.sqrt(dot(sound, sound));
    const soundTerm =
        soundNorm > 0
            ? Prisma.sql`${soundNorm}::float8 * (1 - (te.embedding <=> ${formatEmbedding(sound)}::vector))`
            : Prisma.sql`0::float8`;
    return Prisma.sql`(${soundTerm}
        + ${FEEL_SQ}::float8 * COALESCE((z.v * ${feel[0]}::float8 + z.a * ${feel[1]}::float8) / NULLIF(sqrt(z.v * z.v + z.a * z.a), 0), 0)
        + COALESCE(${bonus}, 0))`;
}

function standardisedFeel(state: MatchingState): Prisma.Sql {
    const { mean, sd } = state.feel;
    const v = sd[0] > 0 ? Prisma.sql`(f.valence::float8 - ${mean[0]}::float8) / ${sd[0]}::float8` : Prisma.sql`0::float8`;
    const a = sd[1] > 0 ? Prisma.sql`(f.arousal::float8 - ${mean[1]}::float8) / ${sd[1]}::float8` : Prisma.sql`0::float8`;
    return Prisma.sql`(SELECT ${v} AS v, ${a} AS a)`;
}

/** Every eligible track except `exclude`, with the `select` columns and one score per set, named by `names`. */
function scoreQuery(
    ctx: MatchingContext,
    sets: WeightedTrack[][],
    names: string[],
    select: Prisma.Sql,
    exclude: string[],
): Prisma.Sql {
    const bonusMaps = sets.map((set) => artistBonuses(set, ctx.state.genres, ctx.state.genreWeight ** 2));
    const artistIds = [...bonusMaps[0].keys()];
    const bonusColumns = bonusMaps.map((m) => Prisma.sql`${artistIds.map((id) => m.get(id)!)}::float8[]`);
    const bonusNames = sets.map((_, k) => Prisma.raw(`v${k}`));
    const scores = sets.map((set, k) => Prisma.sql`${scoreSql(set, Prisma.raw(`b.v${k}`))} AS ${Prisma.raw(`"${names[k]}"`)}`);
    return Prisma.sql`
        WITH bonus AS (
            SELECT * FROM unnest(${artistIds}::text[], ${Prisma.join(bonusColumns)}) AS b(artist_id, ${Prisma.join(bonusNames)})
        )
        SELECT ${select}, ${Prisma.join(scores)}
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        CROSS JOIN LATERAL ${standardisedFeel(ctx.state)} z
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        LEFT JOIN bonus b ON b.artist_id = ar.id
        WHERE te.model_version = ${MATCHING_MODEL}
          AND t."missingSince" IS NULL
          AND te.track_id <> ALL(${exclude})
    `;
}

function tally(keys: string[]): { keys: string[]; counts: number[] } {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return { keys: [...counts.keys()], counts: [...counts.values()] };
}

/**
 * The top `limit` rows of `scored` (LibraryTrack's columns and `score`) with at most
 * MAX_PER_ALBUM per album and MAX_PER_ARTIST per artist, each `counted` track taking
 * one place in its own album and artist. Keeping the best rows per album, then per
 * artist among those, is the same as walking the ranked list in order.
 */
export async function capRanked(scored: Prisma.Sql, counted: Counted[], limit: number): Promise<RankedTrack[]> {
    const albums = tally(counted.map((c) => c.albumId));
    const artists = tally(counted.map((c) => c.artistId));
    return prisma.$queryRaw<RankedTrack[]>(Prisma.sql`
        WITH scored AS (${scored}),
        album_used AS (
            SELECT * FROM unnest(${albums.keys}::text[], ${albums.counts}::int[]) AS u(album_id, used)
        ),
        artist_used AS (
            SELECT * FROM unnest(${artists.keys}::text[], ${artists.counts}::int[]) AS u(artist_id, used)
        ),
        album_ranked AS (
            SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s."albumId" ORDER BY s.score DESC, s.id) AS album_rank
            FROM scored s
        ),
        album_kept AS (
            SELECT r.* FROM album_ranked r
            LEFT JOIN album_used u ON u.album_id = r."albumId"
            WHERE r.album_rank <= ${MAX_PER_ALBUM} - COALESCE(u.used, 0)
        ),
        artist_ranked AS (
            SELECT k.*, ROW_NUMBER() OVER (PARTITION BY k."artistId" ORDER BY k.score DESC, k.id) AS artist_rank
            FROM album_kept k
        )
        SELECT r.id, r.title, r.duration, r."albumId", r."albumTitle", r."albumCoverUrl",
               r."artistId", r."artistName", r.score
        FROM artist_ranked r
        LEFT JOIN artist_used u ON u.artist_id = r."artistId"
        WHERE r.artist_rank <= ${MAX_PER_ARTIST} - COALESCE(u.used, 0)
        ORDER BY r.score DESC, r.id
        LIMIT ${limit}
    `);
}

/** The top `limit` tracks for one input set, inputs excluded, capped with the `counted` inputs taking places. */
export async function rankMatches(
    ctx: MatchingContext,
    inputs: WeightedInput[],
    opts: { limit: number; counted: string[] },
): Promise<RankedTrack[]> {
    const scored = scoreQuery(
        ctx,
        [weightedTracks(ctx, inputs)],
        ["score"],
        TRACK_COLUMNS,
        inputs.map((i) => i.trackId),
    );
    return capRanked(scored, opts.counted.map((id) => ctx.tracks.get(id)!), opts.limit);
}

/** Every eligible track except `exclude`, with one score per input set, in input-set order. */
export async function scoreLibrary(
    ctx: MatchingContext,
    sets: WeightedInput[][],
    exclude: string[],
): Promise<Array<Counted & { id: string; scores: number[] }>> {
    const names = sets.map((_, k) => `s${k}`);
    const rows = await prisma.$queryRaw<ScoredIds[]>(
        scoreQuery(
            ctx,
            sets.map((set) => weightedTracks(ctx, set)),
            names,
            Prisma.sql`t.id, a.id AS "albumId", ar.id AS "artistId"`,
            exclude,
        ),
    );
    return rows.map((r) => ({
        id: r.id,
        albumId: r.albumId,
        artistId: r.artistId,
        scores: names.map((_, k) => r[`s${k}`]),
    }));
}

/** The named tracks with their album and artist, in no particular order. */
export async function libraryTracks(ids: string[]): Promise<LibraryTrack[]> {
    return prisma.$queryRaw<LibraryTrack[]>`
        SELECT ${TRACK_COLUMNS}
        FROM "Track" t
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        WHERE t.id = ANY(${ids})
    `;
}

/** Each named artist's mean unit sound vector and mean feel vector over its eligible tracks. */
export async function artistProfiles(state: MatchingState, artistIds: string[]): Promise<Map<string, ArtistProfile>> {
    const rows = await prisma.$queryRaw<ProfileRow[]>`
        SELECT ar.id AS "artistId",
               avg(l2_normalize(te.embedding))::text AS sound,
               avg(COALESCE(z.v / NULLIF(sqrt(z.v * z.v + z.a * z.a), 0), 0)) AS v,
               avg(COALESCE(z.a / NULLIF(sqrt(z.v * z.v + z.a * z.a), 0), 0)) AS a
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        CROSS JOIN LATERAL ${standardisedFeel(state)} z
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        WHERE ar.id = ANY(${artistIds})
          AND te.model_version = ${MATCHING_MODEL}
          AND t."missingSince" IS NULL
        GROUP BY ar.id
    `;
    return new Map(
        rows.map((r) => [
            r.artistId,
            { artistId: r.artistId, sound: Float64Array.from(parseEmbedding(r.sound)), feel: [r.v, r.a] },
        ]),
    );
}
