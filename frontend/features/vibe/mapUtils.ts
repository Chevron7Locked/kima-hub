import type { MapTrack } from "./types";

export const MOOD_COLORS: Record<string, [number, number, number]> = {
    moodHappy:      [252, 162, 0],   // brand amber #fca200
    moodSad:        [168, 85, 247],  // AI purple #a855f7
    moodRelaxed:    [34, 197, 94],   // green #22c55e
    moodAggressive: [239, 68, 68],   // red #ef4444
    moodParty:      [236, 72, 153],  // pink #ec4899
    moodAcoustic:   [245, 158, 11],  // warm amber #f59e0b
    moodElectronic: [59, 130, 246],  // blue #3b82f6
    neutral:        [163, 163, 163], // neutral-400
};

const MOOD_LABEL_MAP: Record<string, string> = {
    moodHappy: "Upbeat",
    moodSad: "Melancholic",
    moodRelaxed: "Chill",
    moodAggressive: "Intense",
    moodParty: "Dance",
    moodAcoustic: "Acoustic",
    moodElectronic: "Electronic",
    neutral: "Mixed",
};

// Cache is keyed by track.id:moodScore:dominantMood so it auto-invalidates after enrichment.
// Capped at 2000 entries -- evicts oldest when full to prevent unbounded growth on large libraries.
const _moodColorCache = new Map<string, [number, number, number]>();
const MOOD_COLOR_CACHE_MAX = 50000;

/**
 * Blend a track's mood scores into a single RGB color.
 * saturationBoost controls how aggressively the blended color is pushed away from gray.
 * Use 1.6 for sRGB contexts (Deck.gl), 2.0 for linear-light contexts (Three.js).
 */
export function blendMoodColorRGB(track: MapTrack, saturationBoost = 1.6): [number, number, number] {
    const cacheKey = `${track.id}:${track.moodScore}:${track.dominantMood}:${saturationBoost}`;
    const cached = _moodColorCache.get(cacheKey);
    if (cached) return cached;

    const moods = track.moods;
    if (!moods || Object.keys(moods).length === 0) {
        return MOOD_COLORS.neutral;
    }

    let r = 0, g = 0, b = 0, totalWeight = 0;
    for (const [mood, score] of Object.entries(moods)) {
        const color = MOOD_COLORS[mood];
        if (!color || score <= 0) continue;
        const w = score * score * score;
        r += color[0] * w;
        g += color[1] * w;
        b += color[2] * w;
        totalWeight += w;
    }

    let result: [number, number, number];
    if (totalWeight === 0) {
        result = MOOD_COLORS.neutral;
    } else {
        r = r / totalWeight;
        g = g / totalWeight;
        b = b / totalWeight;
        const gray = (r + g + b) / 3;
        r = Math.max(0, Math.min(255, gray + (r - gray) * saturationBoost));
        g = Math.max(0, Math.min(255, gray + (g - gray) * saturationBoost));
        b = Math.max(0, Math.min(255, gray + (b - gray) * saturationBoost));
        result = [Math.round(r), Math.round(g), Math.round(b)];
    }

    if (_moodColorCache.size >= MOOD_COLOR_CACHE_MAX) {
        const firstKey = _moodColorCache.keys().next().value;
        if (firstKey !== undefined) _moodColorCache.delete(firstKey);
    }
    _moodColorCache.set(cacheKey, result);
    return result;
}


export function computeClusterLabels(
    tracks: MapTrack[],
    viewBounds: { minX: number; maxX: number; minY: number; maxY: number },
    gridSize = 5
): Array<{ x: number; y: number; label: string; count: number }> {
    const { minX, maxX, minY, maxY } = viewBounds;
    const cellW = (maxX - minX) / gridSize;
    const cellH = (maxY - minY) / gridSize;

    if (cellW <= 0 || cellH <= 0) return [];

    const grid: Map<string, Map<string, number>> = new Map();

    for (const track of tracks) {
        if (track.x < minX || track.x > maxX || track.y < minY || track.y > maxY) continue;

        const col = Math.min(gridSize - 1, Math.floor((track.x - minX) / cellW));
        const row = Math.min(gridSize - 1, Math.floor((track.y - minY) / cellH));
        const key = `${col},${row}`;

        if (!grid.has(key)) grid.set(key, new Map());
        const cell = grid.get(key)!;
        cell.set(track.dominantMood, (cell.get(track.dominantMood) || 0) + 1);
    }

    const labels: Array<{ x: number; y: number; label: string; count: number }> = [];

    for (const [key, moods] of grid) {
        let total = 0;
        for (const count of moods.values()) total += count;
        if (total < 3) continue;

        let bestMood = "";
        let bestCount = 0;
        for (const [mood, count] of moods) {
            if (count > bestCount) {
                bestMood = mood;
                bestCount = count;
            }
        }

        const [col, row] = key.split(",").map(Number);
        const x = minX + (col + 0.5) * cellW;
        const y = minY + (row + 0.5) * cellH;

        labels.push({ x, y, label: MOOD_LABEL_MAP[bestMood] || "Mixed", count: total });
    }

    return labels;
}

function baseRadiusForZoom(zoom: number): number {
    if (zoom < 6) return 3.5;
    if (zoom < 8) return 4.5 + (zoom - 6) * 1.5;
    if (zoom < 10) return 7.5 + (zoom - 8) * 2.5;
    return 12.5 + (zoom - 10) * 2.5;
}

export function getTrackRadius(track: MapTrack, zoom: number): number {
    const base = baseRadiusForZoom(zoom);
    const energy = track.energy ?? 0.5;
    return base * (0.7 + energy * 0.6);
}

export function computeInitialViewState(tracks: MapTrack[]): {
    target: [number, number, number];
    zoom: number;
} {
    if (tracks.length === 0) {
        return { target: [0.5, 0.5, 0], zoom: 8 };
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of tracks) {
        if (t.x < minX) minX = t.x;
        if (t.x > maxX) maxX = t.x;
        if (t.y < minY) minY = t.y;
        if (t.y > maxY) maxY = t.y;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const dataWidth = maxX - minX || 1;
    const dataHeight = maxY - minY || 1;
    const span = Math.max(dataWidth, dataHeight);

    const viewportSize = typeof window !== "undefined"
        ? Math.min(window.innerWidth, window.innerHeight)
        : 900;
    const zoom = Math.log2(viewportSize / (span * 0.85));

    return {
        target: [cx, cy, 0],
        zoom: Math.max(2, Math.min(12, zoom)),
    };
}
