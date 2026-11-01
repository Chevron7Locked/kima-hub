/**
 * The vibe map as the page draws it: every eligible track's stored position from the similarity step
 * (services/matching/map.ts), scaled into the unit cube with one scale for all three axes so the cloud keeps its
 * shape, with its colour and its current mood fields.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { MATCHING_MODEL } from "./matching/state";
import { MOODS, currentMoodSnapshot, moodOutput } from "./moodBucketService";

interface MapTrack {
    id: string;
    x: number;
    y: number;
    z: number;
    /** Place on the Kima logo's gradient, 0 the azure end to 1 the amber end. */
    colour: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    /** A mood column name, "neutral" (no single mood) or "unanalyzed". */
    dominantMood: string;
    /** Library rank (0..1) of the dominant mood. */
    moodScore: number;
    /** Library rank (0..1) per mood; see moodBucketService. */
    moods: Record<string, number>;
    energy: number | null;
    valence: number | null;
}

export interface MapResponse {
    tracks: MapTrack[];
    trackCount: number;
    computedAt: string;
    /** Mood snapshot the tracks' mood fields come from. */
    moodSignature: string;
}

export type MapState = { status: "ready"; data: MapResponse } | { status: "computing" };

interface Row {
    id: string;
    x: number;
    y: number;
    z: number;
    colour: number;
    title: string;
    artistName: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    energy: number | null;
    valence: number | null;
}

/**
 * The tracks the map draws: laid out by the similarity step, present on disk, and in the library (a DISCOVER album's
 * songs never appear). Shared by the map and the collection's mood summary so both always count the same songs.
 */
const MAP_TRACKS = Prisma.sql`
        FROM matching_map m
        JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        WHERE te.model_version = ${MATCHING_MODEL} AND t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')`;

/** True when no track is laid out yet but the library has songs and sound vectors are on: the first layout is pending. */
async function layoutPending(): Promise<boolean> {
    const { vibeEmbeddings } = await featureDetection.getFeatures();
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM "Track" t WHERE t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')) AS waiting
    `;
    return vibeEmbeddings && waiting;
}

/** The map if the similarity step has laid it out; "computing" while the library waits for its layout. */
export async function getVibeMap(): Promise<MapState> {
    const rows = await prisma.$queryRaw<Row[]>`
        SELECT te.track_id AS id, m.x, m.y, m.z, m.colour, t.title, ar.name AS "artistName", ar.id AS "artistId",
               a.id AS "albumId", a."coverUrl", t.energy, t.valence
        ${MAP_TRACKS}
        ORDER BY te.track_id
    `;
    const snap = await currentMoodSnapshot();
    if (rows.length === 0) {
        if (await layoutPending()) return { status: "computing" };
    }
    const state = await prisma.matchingState.findUnique({ where: { id: "default" }, select: { mapUpdatedAt: true } });

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const r of rows) {
        [r.x, r.y, r.z].forEach((v, d) => {
            if (v < min[d]) min[d] = v;
            if (v > max[d]) max[d] = v;
        });
    }
    const range = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const centre = [0, 1, 2].map((d) => (min[d] + max[d]) / 2);
    const tracks = rows.map((r): MapTrack => ({
        id: r.id,
        x: 0.5 + (r.x - centre[0]) / range,
        y: 0.5 + (r.y - centre[1]) / range,
        z: 0.5 + (r.z - centre[2]) / range,
        colour: r.colour,
        title: r.title,
        artist: r.artistName,
        artistId: r.artistId,
        albumId: r.albumId,
        coverUrl: r.coverUrl,
        ...moodOutput(snap.views.get(r.id)),
        energy: r.energy,
        valence: r.valence,
    }));
    return {
        status: "ready",
        data: {
            tracks,
            trackCount: tracks.length,
            computedAt: (state?.mapUpdatedAt ?? new Date(0)).toISOString(),
            moodSignature: snap.signature,
        },
    };
}

/** What the collection page draws from the mood picture: the band and the mood dots on album and artist cards. */
export interface MoodSummary {
    /** Each mood's share of the analysed tracks, biggest first, "neutral" last, equal counts in legend order. */
    shares: Array<{ key: string; fraction: number }>;
    /** The mood most of an album's tracks share; an album whose winner is "neutral" is left out. */
    albums: Record<string, string>;
    /** The same for artists. */
    artists: Record<string, string>;
}

/** The legend's order: the moods as MOODS lists them, "neutral" after them all. */
export const LEGEND: string[] = MOODS.map((m) => m.field);
const legendPosition = (key: string) => (LEGEND.includes(key) ? LEGEND.indexOf(key) : LEGEND.length);

/**
 * Tally tracks' moods into the band and the per-group winners. "unanalyzed" tracks are left out of everything;
 * any other non-mood value counts as "neutral".
 */
export function summariseMoods(tracks: ReadonlyArray<{ dominantMood: string; albumId: string; artistId: string }>): MoodSummary {
    const total = new Map<string, number>();
    const byAlbum = new Map<string, Map<string, number>>();
    const byArtist = new Map<string, Map<string, number>>();
    let analysed = 0;
    const bump = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
    const tally = (groups: Map<string, Map<string, number>>, id: string, key: string) => {
        let t = groups.get(id);
        if (!t) groups.set(id, (t = new Map()));
        bump(t, key);
    };
    for (const track of tracks) {
        if (!track.dominantMood || track.dominantMood === "unanalyzed") continue;
        const key = LEGEND.includes(track.dominantMood) ? track.dominantMood : "neutral";
        analysed += 1;
        bump(total, key);
        tally(byAlbum, track.albumId, key);
        tally(byArtist, track.artistId, key);
    }
    const winners = (groups: Map<string, Map<string, number>>) => {
        const out: Record<string, string> = {};
        for (const [id, t] of groups) {
            const [best] = [...t.entries()].sort((a, b) => b[1] - a[1] || legendPosition(a[0]) - legendPosition(b[0]));
            if (best[0] !== "neutral") out[id] = best[0];
        }
        return out;
    };
    const shares = [...total.entries()]
        .sort((a, b) => b[1] - a[1] || legendPosition(a[0]) - legendPosition(b[0]))
        .map(([key, count]) => ({ key, fraction: count / analysed }));
    return { shares, albums: winners(byAlbum), artists: winners(byArtist) };
}

export type MoodSummaryState = { status: "ready"; data: MoodSummary } | { status: "computing" };

/** The mood summary over the very tracks the map draws, each with the mood the map gives it. */
export async function getMoodSummary(): Promise<MoodSummaryState> {
    const rows = await prisma.$queryRaw<Array<{ id: string; artistId: string; albumId: string }>>`
        SELECT te.track_id AS id, ar.id AS "artistId", a.id AS "albumId"
        ${MAP_TRACKS}
    `;
    if (rows.length === 0 && (await layoutPending())) return { status: "computing" };
    const snap = await currentMoodSnapshot();
    return {
        status: "ready",
        data: summariseMoods(rows.map((r) => ({ ...r, dominantMood: moodOutput(snap.views.get(r.id)).dominantMood }))),
    };
}
