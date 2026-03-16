import * as THREE from "three";
import type { MapTrack } from "./types";
import { blendMoodColorRGB } from "./mapUtils";

// Three.js renders in linear light -- use a higher saturation boost (2.0) than
// the Deck.gl sRGB path (1.6) to compensate for the linearization difference.
function blendMoodColor(track: MapTrack): [number, number, number] {
    return blendMoodColorRGB(track, 2.0);
}

/** Returns a Three.js Color for a track, normalized to 0-1 range. */
export function getTrackThreeColor(track: MapTrack): THREE.Color {
    const [r, g, b] = blendMoodColor(track);
    return new THREE.Color(r / 255, g / 255, b / 255);
}

/**
 * Returns a subdued color for the Tron aesthetic. Base brightness 0.15-0.35,
 * with energy adding a subtle lift. No HDR -- bloom is handled separately.
 */
export function getTrackColor(track: MapTrack): THREE.Color {
    const [r, g, b] = blendMoodColor(track);
    const energy = track.energy ?? 0.5;
    const brightness = 0.25 + energy * 0.3;
    return new THREE.Color(
        (r / 255) * brightness,
        (g / 255) * brightness,
        (b / 255) * brightness
    );
}

/** Returns a brighter variant for selected/highlighted tracks. */
export function getTrackHighlightColor(track: MapTrack): THREE.Color {
    const [r, g, b] = blendMoodColor(track);
    return new THREE.Color(r / 255 * 0.7, g / 255 * 0.7, b / 255 * 0.7);
}

/** Compute edges connecting each track to its K spatially nearest neighbors. */
export function computeEdges(
    tracks: MapTrack[],
    k = 3
): Array<[number, number]> {
    const edges = new Set<string>();
    const result: Array<[number, number]> = [];

    for (let i = 0; i < tracks.length; i++) {
        const dists: Array<{ j: number; d: number }> = [];
        for (let j = 0; j < tracks.length; j++) {
            if (i === j) continue;
            const dx = tracks[i].x - tracks[j].x;
            const dy = tracks[i].y - tracks[j].y;
            dists.push({ j, d: dx * dx + dy * dy });
        }
        dists.sort((a, b) => a.d - b.d);
        for (let n = 0; n < Math.min(k, dists.length); n++) {
            const j = dists[n].j;
            const key = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (!edges.has(key)) {
                edges.add(key);
                result.push([i, j]);
            }
        }
    }
    return result;
}

/**
 * Computes bounding sphere for a set of tracks (for zoom-to-cluster).
 * Coordinates are in raw 0-1 space -- caller must scale if needed.
 */
export function computeClusterBounds(
    tracks: MapTrack[],
    trackIds: Set<string>
): { center: THREE.Vector3; radius: number } {
    const points: THREE.Vector3[] = [];
    for (const t of tracks) {
        if (trackIds.has(t.id)) {
            points.push(new THREE.Vector3(t.x, t.y, 0));
        }
    }
    if (points.length === 0) {
        return { center: new THREE.Vector3(0.5, 0.5, 0), radius: 0.5 };
    }

    const center = new THREE.Vector3();
    for (const p of points) center.add(p);
    center.divideScalar(points.length);

    let maxDist = 0;
    for (const p of points) {
        const d = center.distanceTo(p);
        if (d > maxDist) maxDist = d;
    }

    return { center, radius: Math.max(maxDist * 1.3, 0.05) };
}
