/**
 * Stats-page figures as playable track lists, so a number on the page is one
 * press from playing it. Every slice matches something the page already states.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { listenRows, type Period } from "./listens";

/** The shape the player wants. Matches what the library routes hand back. */
export interface PlayableTrack {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
}

export type Slice = "top" | "never" | "core" | "key" | "decade";

const MAX_TRACKS = 100;

/** Essentia writes either spelling of a pitch ("C#" or "Db"), so anything
 * that counts or queries by pitch must accept both. */
const ENHARMONIC: Record<string, [string, string]> = {
    "F#": ["F#", "Gb"], "Gb": ["F#", "Gb"],
    "Db": ["Db", "C#"], "C#": ["Db", "C#"],
    "Ab": ["Ab", "G#"], "G#": ["Ab", "G#"],
    "Eb": ["Eb", "D#"], "D#": ["Eb", "D#"],
    "Bb": ["Bb", "A#"], "A#": ["Bb", "A#"],
    "B": ["B", "Cb"], "Cb": ["B", "Cb"],
    "E": ["E", "Fb"], "Fb": ["E", "Fb"],
    "F": ["F", "E#"], "E#": ["F", "E#"],
    "C": ["C", "B#"], "B#": ["C", "B#"],
};

/** Every spelling that means this pitch, including the one asked for. */
export function spellingsOf(pitch: string): string[] {
    return ENHARMONIC[pitch] ?? [pitch];
}

/** One listen per record, the same view every other figure is built on. */

interface Row {
    id: string; title: string; duration: number;
    artist_id: string; artist_name: string;
    album_id: string; album_title: string; cover: string | null;
}

const shape = (rows: Row[]): PlayableTrack[] =>
    rows.map((r) => ({
        id: r.id,
        title: r.title,
        duration: r.duration,
        artist: { id: r.artist_id, name: r.artist_name },
        album: { id: r.album_id, title: r.album_title, coverArt: r.cover },
    }));

/** The columns every slice returns, so the player always gets the same shape. */
const SELECT = Prisma.sql`
    t.id, coalesce(t."displayTitle", t.title) AS title, t.duration,
    ar.id AS artist_id, coalesce(ar."displayName", ar.name) AS artist_name,
    al.id AS album_id, coalesce(al."displayTitle", al.title) AS album_title,
    coalesce(al."userCoverUrl", al."coverUrl") AS cover`;

const JOINS = Prisma.sql`
    JOIN "Album"  al ON al.id = t."albumId"
    JOIN "Artist" ar ON ar.id = al."artistId"`;

export async function playableSlice(params: {
    userId: string;
    slice: Slice;
    /** For "key": e.g. "E minor". For "decade": 1990. */
    key?: string;
    decade?: number;
    limit?: number;
    /**
     * The period the page was showing, so "play those 64" returns the 64 it named.
     * "never" and "decade" ignore it: they describe the shelf, not a period.
     */
    period?: Period;
}): Promise<PlayableTrack[]> {
    const { userId, slice, key, decade, period = "all" } = params;
    // NaN passes `??` and survives Math.min/max, so validate here as well as in the route.
    const asked = Number(params.limit);
    const limit = Math.min(MAX_TRACKS, Math.max(1, Number.isFinite(asked) ? Math.floor(asked) : 40));

    switch (slice) {
        case "top":
        case "core": {
            // "core" is the handful that make up half the listening, so it is
            // the same ordering — the page has already said how many.
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                ${listenRows(userId, period)}
                SELECT ${SELECT}, count(*)::int AS n
                FROM p JOIN "Track" t ON t.id = p."trackId" ${JOINS}
                GROUP BY t.id, t."displayTitle", t.title, t.duration, ar.id, ar."displayName", ar.name,
                         al.id, al."displayTitle", al.title, al."userCoverUrl", al."coverUrl"
                ORDER BY n DESC LIMIT ${limit}`);
            return shape(rows);
        }

        case "never": {
            // Shuffled, because a fixed order would hand back the same corner of
            // the alphabet every time and the point is to find something.
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                SELECT ${SELECT}
                FROM "Track" t ${JOINS}
                WHERE al.location = 'LIBRARY'
                  AND NOT EXISTS (SELECT 1 FROM "Play" p WHERE p."trackId" = t.id AND p."userId" = ${userId})
                ORDER BY random() LIMIT ${limit}`);
            return shape(rows);
        }

        case "key": {
            const [pitch, scale] = (key ?? "").split(" ");
            if (!pitch || (scale !== "major" && scale !== "minor")) return [];
            // The wheel draws one wedge for both spellings, so match both.
            const pitches = spellingsOf(pitch);
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                ${listenRows(userId, period)}
                SELECT ${SELECT}, count(*)::int AS n
                FROM p JOIN "Track" t ON t.id = p."trackId" ${JOINS}
                WHERE t.key IN (${Prisma.join(pitches)}) AND t."keyScale" = ${scale}
                GROUP BY t.id, t."displayTitle", t.title, t.duration, ar.id, ar."displayName", ar.name,
                         al.id, al."displayTitle", al.title, al."userCoverUrl", al."coverUrl"
                ORDER BY n DESC LIMIT ${limit}`);
            return shape(rows);
        }

        case "decade": {
            if (!decade) return [];
            const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
                SELECT ${SELECT}
                FROM "Track" t ${JOINS}
                WHERE al.location = 'LIBRARY'
                  AND coalesce(al."displayYear", al.year) BETWEEN ${decade} AND ${decade + 9}
                ORDER BY random() LIMIT ${limit}`);
            return shape(rows);
        }

        default:
            return [];
    }
}
