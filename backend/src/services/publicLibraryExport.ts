/**
 * The owned library as one gzipped JSON document for the public vibe site: every present
 * track with a map position, its raw 3-axis position, moods, energy, valence and
 * its nearest tracks by the matching formula and how many times the public user
 * has listened to it. Rebuilt only when the library's fingerprint changes, in the
 * background; the fingerprint doubles as the ETag.
 */
import crypto from "crypto";
import { promisify } from "util";
import zlib from "zlib";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config } from "../config";
import { getLiveState, publicUserId } from "./liveListening";
import { MOODS, NEUTRAL, UNANALYZED, refreshMoodSnapshot } from "./moodBucketService";
import { SELF_SCORE } from "./matching/formula";
import { neighbourListsInWorker } from "./matching/neighbours";
import { matchingContext } from "./matching/rank";
import { listenRows } from "./stats/listens";

const gzip = promisify(zlib.gzip);

const EXPORT_VERSION = 2;
const NEIGHBOURS = 8;

export interface LibraryExport {
    etag: string;
    gzipped: Buffer;
    hasPlays: boolean;
}

interface TrackRow {
    id: string;
    title: string;
    duration: number;
    energy: number | null;
    valence: number | null;
    albumId: string;
    albumTitle: string;
    year: number | null;
    artistId: string;
    artistName: string;
    x: number;
    y: number;
    z: number;
}

const MAPPED = Prisma.sql`
    FROM track_embeddings te
    JOIN matching_map m ON m.track_id = te.track_id AND m.embedded_at = te.analyzed_at
    JOIN "Track" t ON t.id = te.track_id
    JOIN "Album" a ON a.id = t."albumId"
    JOIN "Artist" ar ON ar.id = a."artistId"
    WHERE a.location = 'LIBRARY' AND t."missingSince" IS NULL
`;

const OWNED_TRACKS = Prisma.sql`
    SELECT COUNT(*) FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
    WHERE a.location = 'LIBRARY' AND t."missingSince" IS NULL
`;

const MOOD_ID_BY_FIELD = new Map<string, string>(MOODS.map((m) => [m.field, m.id]));

interface Build {
    fingerprint: string;
    promise: Promise<LibraryExport>;
    /** One follow-up build, shared by every caller that saw a newer library while this one ran. */
    next?: Promise<LibraryExport>;
}

let cached: LibraryExport | null = null;
let building: Build | null = null;

/** Plays before today (UTC). A rebuild scores every pair of tracks, far too much to run after each song, so a listen reaches the export once its day has ended. */
const SETTLED = Prisma.sql`"playedAt" < date_trunc('day', now() AT TIME ZONE 'UTC')`;

/** The user whose plays the export carries: none when they have turned off sharing what they play. */
async function sharingUserId(): Promise<string | null> {
    const userId = await publicUserId();
    return userId && getLiveState().status !== "hidden" ? userId : null;
}

async function settledPlays(): Promise<number> {
    const userId = await sharingUserId();
    if (!userId) return 0;
    const [{ plays }] = await prisma.$queryRaw<Array<{ plays: number }>>`
        SELECT COUNT(*)::int AS plays FROM "Play" WHERE "userId" = ${userId} AND ${SETTLED}
    `;
    return plays;
}

/** Listens per track by the stats page's rule, across every source: one song heard through once counts once. */
async function listensByTrack(): Promise<Map<string, number>> {
    const userId = await sharingUserId();
    if (!userId) return new Map();
    const rows = await prisma.$queryRaw<Array<{ trackId: string; plays: number }>>(Prisma.sql`${listenRows(userId)}
        SELECT p."trackId", COUNT(*)::int AS plays FROM p WHERE p.${SETTLED} GROUP BY 1`);
    return new Map(rows.map((r) => [r.trackId, r.plays]));
}

async function fingerprint(moodSignature: string): Promise<string> {
    const plays = await settledPlays();
    const [row] = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT
            COUNT(*) AS n,
            -- Every write to the map stamps this; sums of coordinates can match for two different maps.
            (SELECT "mapUpdatedAt" FROM matching_state WHERE id = 'default') AS "mapAt",
            MAX(te.analyzed_at) AS embedded,
            MAX(t."updatedAt") AS touched,
            SUM(hashtext(a.title || ar.name || COALESCE(a.year::text, ''))) AS names,
            (${OWNED_TRACKS}) AS total,
            (SELECT "builtAt" FROM matching_state WHERE id = 'default') AS matching
        ${MAPPED}
    `;
    const raw = JSON.stringify([EXPORT_VERSION, row, moodSignature, plays], (_k, v) =>
        typeof v === "bigint" ? v.toString() : v
    );
    return '"' + crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32) + '"';
}

/** Each mapped track's nearest mapped tracks by the matching formula, scored 1 for a track against itself. */
async function nearestNeighbours(ids: string[]): Promise<Map<string, Array<[string, number]>>> {
    const ctx = await matchingContext(ids);
    if (!ctx) return new Map();
    const tracks = ids.flatMap((id) => ctx.tracks.get(id) ?? []);
    const lists = await neighbourListsInWorker(tracks, ctx.state.genres, ctx.state.genreWeight ** 2, NEIGHBOURS);
    const scaled = new Map<string, Array<[string, number]>>();
    for (const [id, list] of lists) {
        scaled.set(id, list.map(([neighbour, score]) => [neighbour, round(score / SELF_SCORE, 4)]));
    }
    return scaled;
}

function libraryId(): string {
    const slug = (config.publicVibe?.username ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return slug || "library";
}

function round(value: number, places: number): number {
    const f = 10 ** places;
    return Math.round(value * f) / f;
}

async function build(etag: string): Promise<LibraryExport> {
    const started = Date.now();
    const { snapshot } = await refreshMoodSnapshot();
    const rows = await prisma.$queryRaw<TrackRow[]>`
        SELECT
            t.id, COALESCE(t."displayTitle", t.title) AS title, t.duration, t.energy, t.valence,
            a.id AS "albumId", a.title AS "albumTitle", a.year,
            ar.id AS "artistId", ar.name AS "artistName",
            m.x, m.y, m.z
        ${MAPPED}
        ORDER BY t.id
    `;
    const [{ total }] = await prisma.$queryRaw<Array<{ total: bigint }>>`SELECT (${OWNED_TRACKS}) AS total`;
    const [{ model }] = await prisma.$queryRaw<Array<{ model: string | null }>>`
        SELECT mode() WITHIN GROUP (ORDER BY model_version) AS model FROM track_embeddings
    `;
    const [{ analyzer }] = await prisma.$queryRaw<Array<{ analyzer: string | null }>>`
        SELECT mode() WITHIN GROUP (ORDER BY "analysisVersion") AS analyzer FROM "Track"
        WHERE "analysisVersion" IS NOT NULL
    `;
    const neighbours = await nearestNeighbours(rows.map((r) => r.id));
    const listens = await listensByTrack();

    const artists = new Map<string, { id: string; name: string }>();
    const albums = new Map<string, { id: string; artistId: string; title: string; year: number | null }>();
    const tracks = rows.map((r) => {
        artists.set(r.artistId, { id: r.artistId, name: r.artistName });
        albums.set(r.albumId, { id: r.albumId, artistId: r.artistId, title: r.albumTitle, year: r.year });
        const view = snapshot.views.get(r.id);
        const dominant = view && view.dominant !== NEUTRAL && view.dominant !== UNANALYZED
            ? MOOD_ID_BY_FIELD.get(view.dominant) ?? null
            : null;
        return {
            id: r.id,
            title: r.title,
            artistId: r.artistId,
            albumId: r.albumId,
            duration: r.duration,
            xyz: [round(r.x, 5), round(r.y, 5), round(r.z, 5)],
            mood: dominant,
            moods: (view?.moods ?? []).map((f) => MOOD_ID_BY_FIELD.get(f)).filter(Boolean),
            energy: r.energy === null ? null : round(r.energy, 3),
            valence: r.valence === null ? null : round(r.valence, 3),
            neighbours: neighbours.get(r.id) ?? [],
            plays: listens.get(r.id) ?? 0,
        };
    });

    const body = JSON.stringify({
        version: EXPORT_VERSION,
        computedAt: new Date().toISOString(),
        library: {
            id: libraryId(),
            name: config.publicVibe?.username ?? "",
            engine: { analyzer, embedding: model },
        },
        moods: MOODS.map((m) => ({ id: m.id, name: m.name })),
        artists: [...artists.values()],
        albums: [...albums.values()],
        tracks,
        excluded: Number(total) - tracks.length,
    });
    const gzipped = await gzip(body, { level: 9 });
    logger.info(
        `[PUBLIC-VIBE] library export: ${tracks.length} tracks, ${body.length} bytes, ${gzipped.length} gzipped, ${Date.now() - started}ms`
    );
    return { etag, gzipped, hasPlays: listens.size > 0 };
}

/**
 * The export for the library as it is now. One build runs at a time: callers that see
 * a newer library than the running build's share one follow-up build, which starts
 * when the running one ends and builds the library as it is then.
 */
export async function refreshLibraryExport(): Promise<LibraryExport> {
    const { snapshot } = await refreshMoodSnapshot();
    const etag = await fingerprint(snapshot.signature);
    if (cached?.etag === etag) return cached;
    if (building) {
        if (building.fingerprint === etag) return building.promise;
        building.next ??= building.promise.then(refreshLibraryExport, refreshLibraryExport);
        return building.next;
    }
    const current: Build = {
        fingerprint: etag,
        promise: build(etag).then((result) => {
            cached = result;
            return result;
        }),
    };
    building = current;
    const settle = () => {
        if (building === current) building = null;
    };
    current.promise.then(settle, settle);
    return current.promise;
}

/**
 * The last finished export, or null before the first one exists. A build takes
 * seconds to tens of seconds on a large library, so callers never wait for it:
 * each call starts a rebuild in the background when the library has changed.
 */
export function latestLibraryExport(): LibraryExport | null {
    refreshLibraryExport().catch((err) => {
        logger.error(`[PUBLIC-VIBE] library export failed: ${(err as Error).message}`);
    });
    // Built before sharing was turned off: its play counts are no longer anyone's to read, so it waits for the rebuild.
    if (cached?.hasPlays && getLiveState().status === "hidden") return null;
    return cached;
}
