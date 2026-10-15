/**
 * The vibe map in the similarity step: the whole library is laid out once, when there is no layout for this formula
 * yet; after that each new or re-embedded track is placed among the laid-out ones and no track that has a place moves
 * again. Positions and colours are stored per track; the page only draws them.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { parseEmbedding } from "../../utils/embedding";
import { feelVector, unit, type MatchTrack } from "./formula";
import type { LaidOutMap, PlacedTracks } from "./mapCompute";
import type { ColourFrame } from "./mapLayout";
import { MATCHING_MODEL, PROBE_ID, STATE_VERSION, loadMatchingState, type MatchingState } from "./state";
import { runInWorker } from "./worker";

/** Raise when the layout arithmetic changes, so every library is laid out again. */
const LAYOUT_VERSION = 1;
const MAP_VERSION = `${STATE_VERSION}/${LAYOUT_VERSION}`;
const WRITE_CHUNK = 5000;

interface StoredFrame {
    colour: ColourFrame;
    maxScore: number;
}

interface TrackRow {
    id: string;
    albumId: string;
    artistId: string;
    embedding: string;
    valence: number;
    arousal: number;
    /** The sound vector's timestamp as Postgres prints it, so it is written back to the microsecond. */
    embeddedAt: string;
    x: number | null;
    y: number | null;
    z: number | null;
    laidOut: boolean | null;
}

export interface MapUpdate {
    laidOut: number;
    placed: number;
}

const mapComputeModule = require.resolve("./mapCompute");
let running: Promise<MapUpdate> | null = null;

/**
 * One run of the map part of the similarity step; concurrent callers share it. `inputsSettled` says the library's
 * artist genres, analysis and sound vectors are all settled: a library is laid out only then, since its layout is
 * permanent and every later track is placed around it.
 */
export function updateMap(inputsSettled: boolean): Promise<MapUpdate> {
    running ??= update(inputsSettled).finally(() => {
        running = null;
    });
    return running;
}

function standardised(rows: TrackRow[], state: MatchingState): Float64Array {
    const z = new Float64Array(rows.length * 2);
    rows.forEach((r, i) => {
        const { mean, sd } = state.feel;
        z[i * 2] = sd[0] > 0 ? (Math.fround(r.valence) - mean[0]) / sd[0] : 0;
        z[i * 2 + 1] = sd[1] > 0 ? (Math.fround(r.arousal) - mean[1]) / sd[1] : 0;
    });
    return z;
}

function toTrack(r: TrackRow, state: MatchingState): MatchTrack {
    return {
        trackId: r.id,
        albumId: r.albumId,
        artistId: r.artistId,
        sound: unit(parseEmbedding(r.embedding)),
        feel: feelVector([Math.fround(r.valence), Math.fround(r.arousal)], state.feel),
    };
}

function positionsOf(rows: TrackRow[]): Float64Array {
    const out = new Float64Array(rows.length * 3);
    rows.forEach((r, i) => {
        out[i * 3] = r.x!;
        out[i * 3 + 1] = r.y!;
        out[i * 3 + 2] = r.z!;
    });
    return out;
}

async function writeRows(
    tx: Prisma.TransactionClient,
    rows: TrackRow[],
    positions: Float64Array,
    colour: Float64Array,
    laidOut: boolean,
): Promise<void> {
    for (let start = 0; start < rows.length; start += WRITE_CHUNK) {
        const part = rows.slice(start, start + WRITE_CHUNK);
        const at = (axis: number) => part.map((_, i) => positions[(start + i) * 3 + axis]);
        await tx.$executeRaw`
            INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out)
            SELECT u.id, u.embedded_at, u.x, u.y, u.z, u.colour, ${laidOut}
            FROM unnest(
                ${part.map((r) => r.id)}::text[],
                ${part.map((r) => r.embeddedAt)}::timestamptz[],
                ${at(0)}::float8[],
                ${at(1)}::float8[],
                ${at(2)}::float8[],
                ${part.map((_, i) => colour[start + i])}::float8[]
            ) AS u(id, embedded_at, x, y, z, colour)
            ON CONFLICT (track_id) DO UPDATE
            SET embedded_at = EXCLUDED.embedded_at, x = EXCLUDED.x, y = EXCLUDED.y, z = EXCLUDED.z,
                colour = EXCLUDED.colour, laid_out = EXCLUDED.laid_out
        `;
    }
}

/** Whether the map is laid out at this version, and whether every eligible track has a place on it. */
async function mapStatus(): Promise<{ laidOut: boolean; complete: boolean }> {
    const meta = await prisma.matchingState.findUnique({
        where: { id: "default" },
        select: { mapVersion: true, mapFrame: true },
    });
    if (!meta || meta.mapVersion !== MAP_VERSION || meta.mapFrame === null) return { laidOut: false, complete: false };
    const [counts] = await prisma.$queryRaw<{ unplaced: bigint; laidOut: bigint }[]>`
        SELECT count(*) FILTER (WHERE m.track_id IS NULL) AS unplaced,
               count(*) FILTER (WHERE m.laid_out) AS "laidOut"
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        JOIN "Track" t ON t.id = te.track_id
        LEFT JOIN matching_map m ON m.track_id = te.track_id AND m.embedded_at = te.analyzed_at
        WHERE te.model_version = ${MATCHING_MODEL} AND t."missingSince" IS NULL
    `;
    const laidOut = Number(counts?.laidOut ?? 0) >= 2;
    return { laidOut, complete: laidOut && Number(counts?.unplaced ?? 0) === 0 };
}

/**
 * Writes map rows only while the state they were computed from still stands. The state row is locked first, and a
 * re-run deletes that row before the stored map, so the two queue on the one row: a re-run that came first leaves
 * nothing to lock and the write is dropped; a write that came first finishes, and the re-run then clears it.
 */
async function writeWhileStateStands(write: (tx: Prisma.TransactionClient) => Promise<void>): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
        const state = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM matching_state WHERE id = 'default' FOR UPDATE`;
        if (state.length === 0) return false;
        await write(tx);
        return true;
    });
}

async function update(inputsSettled: boolean): Promise<MapUpdate> {
    const state = await loadMatchingState();
    if (!state) return { laidOut: 0, placed: 0 };
    // This runs every enrichment cycle: count first, and load the vectors only when
    // there is a track to place or a layout that can be made now. The first layout
    // waits for the library to settle, so until then nothing is loaded.
    const status = await mapStatus();
    if (status.complete) return { laidOut: 0, placed: 0 };
    if (!status.laidOut && !inputsSettled) return { laidOut: 0, placed: 0 };
    const rows = await prisma.$queryRaw<TrackRow[]>`
        SELECT te.track_id AS id, t."albumId", a."artistId", te.embedding::text AS embedding, f.valence, f.arousal,
               te.analyzed_at::text AS "embeddedAt", m.x, m.y, m.z, m.laid_out AS "laidOut"
        FROM track_embeddings te
        JOIN matching_feel f ON f.track_id = te.track_id AND f.embedded_at = te.analyzed_at AND f.probe = ${PROBE_ID}
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        LEFT JOIN matching_map m ON m.track_id = te.track_id AND m.embedded_at = te.analyzed_at
        WHERE te.model_version = ${MATCHING_MODEL} AND t."missingSince" IS NULL
        ORDER BY te.track_id
    `;
    if (rows.length === 0) return { laidOut: 0, placed: 0 };
    const meta = await prisma.matchingState.findUnique({
        where: { id: "default" },
        select: { mapVersion: true, mapFrame: true },
    });
    if (!meta) return { laidOut: 0, placed: 0 };
    if (rows.length === 1) {
        if (!inputsSettled || (rows[0].x !== null && meta.mapVersion === MAP_VERSION)) return { laidOut: 0, placed: 0 };
        const written = await writeWhileStateStands(async (tx) => {
            await tx.$executeRaw`DELETE FROM matching_map`;
            await writeRows(tx, rows, new Float64Array(3), Float64Array.of(0.5), true);
            await tx.matchingState.update({
                where: { id: "default" },
                data: { mapVersion: MAP_VERSION, mapFrame: Prisma.DbNull, mapUpdatedAt: new Date() },
            });
        });
        return { laidOut: written ? 1 : 0, placed: 0 };
    }
    const unplaced = rows.filter((r) => r.x === null);
    const laidOutRows = rows.filter((r) => r.laidOut === true);
    const relayout = meta.mapVersion !== MAP_VERSION || meta.mapFrame === null || laidOutRows.length < 2;

    if (relayout) {
        if (!inputsSettled) return { laidOut: 0, placed: 0 };
        const tracks = rows.map((r) => toTrack(r, state));
        const map = await runInWorker<LaidOutMap>(mapComputeModule, "layoutLibrary", [
            tracks,
            standardised(rows, state),
            state.genres,
            state.genreWeight,
        ]);
        const frame: StoredFrame = { colour: map.frame, maxScore: map.maxScore };
        const written = await writeWhileStateStands(async (tx) => {
            await tx.$executeRaw`DELETE FROM matching_map`;
            await writeRows(tx, rows, map.positions, map.colour, true);
            await tx.matchingState.update({
                where: { id: "default" },
                data: {
                    mapVersion: MAP_VERSION,
                    mapFrame: frame as unknown as Prisma.InputJsonValue,
                    mapUpdatedAt: new Date(),
                },
            });
        });
        return { laidOut: written ? rows.length : 0, placed: 0 };
    }

    if (unplaced.length === 0) return { laidOut: 0, placed: 0 };
    const positionedRows = rows.filter((r) => r.x !== null);
    const frame = meta.mapFrame as unknown as StoredFrame;
    const placed = await runInWorker<PlacedTracks>(mapComputeModule, "placeTracks", [
        laidOutRows.map((r) => toTrack(r, state)),
        positionsOf(laidOutRows),
        positionsOf(positionedRows),
        unplaced.map((r) => toTrack(r, state)),
        state.genres,
        state.genreWeight,
        frame.colour,
        frame.maxScore,
    ]);
    const written = await writeWhileStateStands(async (tx) => {
        await writeRows(tx, unplaced, placed.positions, placed.colour, false);
        await tx.matchingState.update({
            where: { id: "default" },
            data: { mapUpdatedAt: new Date() },
        });
    });
    return { laidOut: 0, placed: written ? unplaced.length : 0 };
}
