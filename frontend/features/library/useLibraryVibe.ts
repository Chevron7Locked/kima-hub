"use client";

/**
 * The library's mood picture, read from the vibe map: each mood's share of the
 * analysed tracks for the masthead band, and the mood each album and artist
 * shares with its tracks for the card dots. Shares the map's cache with the
 * vibe page; while the map is still being laid out the band shows as a quiet
 * track and no card is marked.
 */

import { useMemo } from "react";
import { moodByGroup, moodShares, type MoodShare } from "@/features/vibe/mapUtils";
import { useVibeMapQuery } from "@/features/vibe/useVibeMap";

const EMPTY_MAP = new Map<string, string>();

export function useLibraryVibe() {
    const tracks = useVibeMapQuery().mapData?.tracks;

    const shares = useMemo<MoodShare[]>(() => (tracks ? moodShares(tracks) : []), [tracks]);
    const albumMood = useMemo(
        () => (tracks ? moodByGroup(tracks.map((t) => ({ id: t.albumId, dominantMood: t.dominantMood }))) : EMPTY_MAP),
        [tracks],
    );
    const artistMood = useMemo(
        () => (tracks ? moodByGroup(tracks.map((t) => ({ id: t.artistId, dominantMood: t.dominantMood }))) : EMPTY_MAP),
        [tracks],
    );

    return { shares, albumMood, artistMood };
}
