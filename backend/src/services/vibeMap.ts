/**
 * The vibe map as the page draws it: every eligible track's stored position from the similarity step
 * (services/matching/map.ts), scaled into the unit cube with one scale for all three axes so the cloud keeps its
 * shape, with its colour and its current mood fields.
 */
import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { MATCHING_MODEL } from "./matching/state";
import { currentMoodSnapshot, moodOutput } from "./moodBucketService";

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

/** The map if the similarity step has laid it out; "computing" while the library waits for its layout. */
export async function getVibeMap(): Promise<MapState> {
    const rows = await prisma.$queryRaw<Row[]>`
        SELECT te.track_id AS id, m.x, m.y, m.z, m.colour, t.title, ar.name AS "artistName", ar.id AS "artistId",
               a.id AS "albumId", a."coverUrl", t.energy, t.valence
        FROM matching_map m
        JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
        JOIN "Track" t ON t.id = te.track_id
        JOIN "Album" a ON a.id = t."albumId"
        JOIN "Artist" ar ON ar.id = a."artistId"
        WHERE te.model_version = ${MATCHING_MODEL} AND t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')
        ORDER BY te.track_id
    `;
    const snap = await currentMoodSnapshot();
    if (rows.length === 0) {
        const { vibeEmbeddings } = await featureDetection.getFeatures();
        const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM "Track" t WHERE t."missingSince" IS NULL AND EXISTS (SELECT 1 FROM "Album" la WHERE la.id = t."albumId" AND la.location = 'LIBRARY')) AS waiting
        `;
        if (vibeEmbeddings && waiting) return { status: "computing" };
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
