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

const _moodColorCache = new Map<string, [number, number, number]>();
const MOOD_COLOR_CACHE_MAX = 50000;

/**
 * Blend a track's mood scores into a single RGB color.
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

// ── Cluster labels for the vibe map ────────────────────────────────────
// The original algorithm: 5×5 grid, drops cells with < 3 tracks.
// Problem: with 73% acoustic/electronic and tiny counts for rarer moods,
// nearly every cell that ISN'T acoustic or electronic has < 3 tracks and
// gets discarded — the map only ever showed two vibes.
//
// Fix (8-track library):  8×8 grid (finer spatial resolution), no minimum
// threshold (every occupied cell contributes), 4-connected BFS merge so
// adjacent same-mood cells collapse into a single labelled region, cap at
// N labels (default 8) sorted by count descending.
// ───────────────────────────────────────────────────────────────────────

export function computeClusterLabels(
    tracks: MapTrack[],
    viewBounds: { minX: number; maxX: number; minY: number; maxY: number },
    gridSize = 8,
    opts?: { maxLabels?: number }
): Array<{ x: number; y: number; label: string; count: number }> {

    const { minX, maxX, minY, maxY } = viewBounds;
    const cellW = (maxX - minX) / gridSize;
    const cellH = (maxY - minY) / gridSize;

    if (cellW <= 0 || cellH <= 0) return [];

    /* --- populate grid: (col,row) → mood→count --- */
    const grid = new Map<string, Map<string, number>>();

    for (const track of tracks) {
        if (track.x < minX || track.x > maxX || track.y < minY || track.y > maxY) continue;
        const col = Math.min(gridSize - 1, Math.floor((track.x - minX) / cellW));
        const row = Math.min(gridSize - 1, Math.floor((track.y - minY) / cellH));
        const key = `${col},${row}`;
        if (!grid.has(key)) grid.set(key, new Map());
        const cell = grid.get(key)!;
        cell.set(track.dominantMood, (cell.get(track.dominantMood) ?? 0) + 1);
    }

    /* --- step 1: dominant mood per cell (threshold = 1) --- */
    type CellInfo = { col: number; row: number; label: string; total: number };
    const cellInfos: CellInfo[] = [];

    for (const [key, moods] of grid) {
        let total = 0;
        for (const c of moods.values()) total += c;
        if (total < 1) continue;              // allow even a single-track cell

        let bestMood = "", bestCount = 0;
        for (const [mood, count] of moods) {
            if (count > bestCount) { bestMood = mood; bestCount = count; }
        }
        if (!bestMood) continue;

        const [col, row] = key.split(",").map(Number);
        cellInfos.push({
            col, row,
            label: MOOD_LABEL_MAP[bestMood] ?? "Mixed",
            total,
        });
    }

    /* --- step 2: 4-connected BFS merge of adjacent same-mood cells --- */
    const visited = new Set<number>();
    type Region = { cx: number; cy: number; label: string; count: number };
    const regions: Region[] = [];

    for (let i = 0; i < cellInfos.length; i++) {
        if (visited.has(i)) continue;

        const regionLabel = cellInfos[i].label;
        const queue: number[] = [i];
        visited.add(i);

        let sx = 0, sy = 0, stotal = 0, cellCount = 0;

        while (queue.length) {
            const idx = queue.shift()!;
            const cur = cellInfos[idx];
            sx += (cur.col + 0.5);
            sy += (cur.row + 0.5);
            stotal += cur.total;
            cellCount++;

            const dirs: [number, number][] = [
                [cur.col + 1, cur.row],
                [cur.col - 1, cur.row],
                [cur.col, cur.row + 1],
                [cur.col, cur.row - 1],
            ];
            for (const [nc, nr] of dirs) {
                for (let j = 0; j < cellInfos.length; j++) {
                    if (visited.has(j)) continue;
                    const nb = cellInfos[j];
                    if (nb.label === regionLabel && nb.col === nc && nb.row === nr) {
                        visited.add(j);
                        queue.push(j);
                        break;
                    }
                }
            }
        }

        regions.push({
            cx: minX + ((sx / cellCount) * cellW),
            cy: minY + ((sy / cellCount) * cellH),
            label: regionLabel,
            count: stotal,
        });
    }

    /* --- step 3: cap – largest regions first --- */
    regions.sort((a, b) => b.count - a.count);
    const maxLabels = opts?.maxLabels ?? 8;
    if (maxLabels < regions.length) regions.splice(maxLabels);

    return regions.map(r => ({ x: r.cx, y: r.cy, label: r.label, count: r.count }));
}

function baseRadiusForZoom(zoom: number): number {
    if (zoom < 6) return 2.8;
    if (zoom < 8) return 3.5 + (zoom - 6) * 1.2;
    if (zoom < 10) return 5.9 + (zoom - 8) * 2.0;
    return 9.9 + (zoom - 10) * 2.0;
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
