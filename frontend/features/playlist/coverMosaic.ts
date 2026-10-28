/**
 * The covers for a playlist's tile: each album's cover once, the albums with the most tracks first, at most four. The
 * tile (CoverArt) fits itself to how many there are.
 */
export function mosaicCovers(covers: Iterable<string | null | undefined>): string[] {
    const counts = new Map<string, number>();
    for (const cover of covers) {
        if (cover) counts.set(cover, (counts.get(cover) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cover]) => cover)
        .slice(0, 4);
}
