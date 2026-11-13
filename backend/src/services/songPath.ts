import { logger } from "../utils/logger";
import { UserFacingError } from "../utils/errors";
import { prisma } from "../utils/db";
import { PLAYABLE_SONG } from "../utils/libraryEligibility";
import { SELF_SCORE, pairScore, slerpWeights } from "./matching/formula";
import { libraryTracks, matchingContext, scoreLibrary, type LibraryTrack } from "./matching/rank";

const MIN_PATH_DISTANCE = 0.15;

interface PathResult {
    startTrack: LibraryTrack;
    endTrack: LibraryTrack;
    path: LibraryTrack[];
    metadata: {
        totalTracks: number;
        embeddingDistance: number;
        averageStepSize: number;
        mode: string;
    };
}

interface Candidate {
    id: string;
    artistId: string;
    distance: number;
}

/** The `size` unvisited tracks closest by `distance`, closest first. */
function nearest<T extends { id: string; artistId: string }>(
    tracks: T[],
    visited: Set<string>,
    size: number,
    distance: (track: T) => number,
): Candidate[] {
    const out: Candidate[] = [];
    const before = (a: Candidate, b: Candidate) => a.distance < b.distance || (a.distance === b.distance && a.id < b.id);
    for (const track of tracks) {
        if (visited.has(track.id)) continue;
        const c = { id: track.id, artistId: track.artistId, distance: distance(track) };
        if (out.length === size && !before(c, out[size - 1])) continue;
        let i = Math.min(out.length, size - 1);
        out[i] = c;
        for (; i > 0 && before(out[i], out[i - 1]); i--) [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
    return out;
}

/**
 * A path between two playable songs (404 for an endpoint that is not one) on the matching formula: waypoints spaced evenly along
 * the arc from one to the other (more for distant pairs), each filled by one of the
 * closest unvisited tracks, with an artist diversity rule.
 */
export async function generateSongPath(
    startTrackId: string,
    endTrackId: string,
    options: { length?: number; mode?: "smooth" | "discovery" } = {}
): Promise<PathResult> {
    const mode = options.mode || "smooth";

    // A path that starts or ends on a song that won't play would hand the listener a queue that breaks at its ends.
    const endpoints = [...new Set([startTrackId, endTrackId])];
    const playable = await prisma.track.count({ where: { id: { in: endpoints }, ...PLAYABLE_SONG } });
    if (playable < endpoints.length) {
        throw new UserFacingError("The start and end songs must be songs that play", 404);
    }

    const ctx = await matchingContext([startTrackId, endTrackId]);
    const start = ctx?.tracks.get(startTrackId);
    const end = ctx?.tracks.get(endTrackId);
    if (!ctx || !start || !end) {
        throw new UserFacingError("One or both tracks have not been through the similarity step yet", 400);
    }

    const cosTheta = pairScore(start, end, ctx.state.genres, ctx.state.genreWeight ** 2) / SELF_SCORE;
    const distance = 1 - cosTheta;
    if (distance < MIN_PATH_DISTANCE) {
        throw new UserFacingError(
            "These tracks are too similar for a meaningful journey. Try \"Similar Tracks\" instead.",
            400,
        );
    }

    const numWaypoints = options.length || Math.max(8, Math.min(50, Math.round(distance * 15)));
    logger.info(`[SONG-PATH] Generating ${mode} path: ${numWaypoints} waypoints, distance=${distance.toFixed(3)}`);

    const library = await scoreLibrary(
        ctx,
        [[{ trackId: startTrackId, weight: 1 }], [{ trackId: endTrackId, weight: 1 }]],
        [startTrackId, endTrackId],
    );

    const candidateLimit = mode === "discovery" ? 10 : 8;
    const visited = new Set<string>();
    const picked: Candidate[] = [];
    let totalStepSize = 0;

    for (let i = 1; i <= numWaypoints; i++) {
        const [w0, w1] = slerpWeights(cosTheta, i / (numWaypoints + 1));
        const candidates = nearest(
            library,
            visited,
            candidateLimit,
            (t) => 1 - (w0 * t.scores[0] + w1 * t.scores[1]) / SELF_SCORE,
        );
        if (candidates.length === 0) break;

        const pickIndex = mode === "discovery"
            ? Math.floor(Math.random() * Math.min(3, candidates.length))
            : 0;
        let selected = candidates[pickIndex];

        if (picked.length >= 2) {
            const prev1 = picked[picked.length - 1];
            const prev2 = picked[picked.length - 2];
            if (prev1.artistId === prev2.artistId && selected.artistId === prev1.artistId) {
                const threshold = candidates[0].distance * 1.05;
                const alt = candidates.find((c) => c.artistId !== prev1.artistId && c.distance <= threshold);
                if (alt) selected = alt;
            }
        }

        visited.add(selected.id);
        totalStepSize += selected.distance;
        picked.push(selected);
    }

    const info = new Map(
        (await libraryTracks([startTrackId, endTrackId, ...picked.map((p) => p.id)])).map((t) => [t.id, t]),
    );
    return {
        startTrack: info.get(startTrackId)!,
        endTrack: info.get(endTrackId)!,
        path: picked.map((p) => info.get(p.id)!),
        metadata: {
            totalTracks: picked.length + 2,
            embeddingDistance: distance,
            averageStepSize: picked.length > 0 ? totalStepSize / picked.length : 0,
            mode,
        },
    };
}
