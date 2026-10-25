import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { notify } from "@/lib/notify";
import { stationBatches } from "@/lib/station-refill";
import { useState } from "react";
import { plural } from "@/lib/format";

export interface RadioStation {
    id: string;
    name: string;
    description: string;
    color: string;
    hoverBorder: string;
    accentGradient: string;
    filter: {
        type: "genre" | "decade" | "discovery" | "favorites" | "all" | "workout" | "mood";
        value?: string;
    };
    minTracks?: number;
    /** Plays from the learned moods, which are scored from sound vectors: nothing to play without the vibe analyzer. */
    needsMoods?: boolean;
}

export interface GenreCount {
    genre: string;
    count: number;
}

export interface DecadeCount {
    decade: number;
    count: number;
}

/**
 * The mood, Wildcard and workout stations play every song that matches, however few (stationPage in
 * backend/src/services/mixes/stationOrder.ts), so any song at all is enough to start one.
 */
const STATION_MIN_TRACKS = 1;

export const STATIC_STATIONS: RadioStation[] = [
    {
        id: "all",
        name: "Shuffle All",
        description: "Your entire library",
        color: "from-[#fca208]/15 to-[#f97316]/10",
        hoverBorder: "hover:border-brand/40",
        accentGradient: "from-[#fca208] to-[#f97316]",
        filter: { type: "all" },
        minTracks: 10,
    },
    {
        id: "workout",
        name: "Workout",
        description: "High energy tracks",
        color: "from-[#ef4444]/15 to-[#f97316]/10",
        hoverBorder: "hover:border-[#ef4444]/40",
        accentGradient: "from-[#ef4444] to-[#f97316]",
        filter: { type: "workout" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "discovery",
        name: "Discovery",
        description: "Lesser-played gems",
        color: "from-[#22c55e]/15 to-[#14b8a6]/10",
        hoverBorder: "hover:border-[#22c55e]/40",
        accentGradient: "from-[#22c55e] to-[#14b8a6]",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: "Favorites",
        description: "Most played",
        color: "from-[#f43f5e]/15 to-[#e11d48]/10",
        hoverBorder: "hover:border-[#f43f5e]/40",
        accentGradient: "from-[#f43f5e] to-[#e11d48]",
        filter: { type: "favorites" },
        minTracks: 10,
    },
];

/**
 * The mood stations the server plays (MOOD_STATIONS and Wildcard in backend/src/routes/library/tracks.ts), in the
 * order they were approved. Each subtitle names the three heaviest parts of the station's recipe
 * (backend/src/services/mixes/recipes.json), ties in the recipe's order, a "low:" part as "not …" and the arousal
 * reading as "high energy" or "low energy" (mood-stations.test.ts holds them to it); Wildcard plays the songs with
 * no mood tag. The colours follow the vibe
 * map's muted mood palette (features/vibe/mapUtils.ts), written out in full so Tailwind finds the classes.
 */
export const MOOD_STATIONS: RadioStation[] = [
    {
        id: "mood-calm",
        name: "Calm",
        description: "Calm, dreamy, low energy",
        color: "from-[#5bc2b4]/15 to-[#3f8f9c]/10",
        hoverBorder: "hover:border-[#5bc2b4]/40",
        accentGradient: "from-[#5bc2b4] to-[#3f8f9c]",
        filter: { type: "mood", value: "calm" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-energy",
        name: "Energy",
        description: "Party, energetic, groovy",
        color: "from-[#e06ab0]/15 to-[#f0905a]/10",
        hoverBorder: "hover:border-[#e06ab0]/40",
        accentGradient: "from-[#e06ab0] to-[#f0905a]",
        filter: { type: "mood", value: "energy" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-intense",
        name: "Intense",
        description: "Aggressive, dark, quirky",
        color: "from-[#e0685e]/15 to-[#8c3a4a]/10",
        hoverBorder: "hover:border-[#e0685e]/40",
        accentGradient: "from-[#e0685e] to-[#8c3a4a]",
        filter: { type: "mood", value: "intense" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-happy",
        name: "Happy",
        description: "Happy, uplifting, high energy",
        color: "from-[#f0b25a]/15 to-[#e8875a]/10",
        hoverBorder: "hover:border-[#f0b25a]/40",
        accentGradient: "from-[#f0b25a] to-[#e8875a]",
        filter: { type: "mood", value: "happy" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-melancholy",
        name: "Melancholy",
        description: "Sad, low energy, romantic",
        color: "from-[#b98fe0]/15 to-[#6f6fc4]/10",
        hoverBorder: "hover:border-[#b98fe0]/40",
        accentGradient: "from-[#b98fe0] to-[#6f6fc4]",
        filter: { type: "mood", value: "melancholy" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-summer",
        name: "Summer",
        description: "Summery, happy, groovy",
        color: "from-[#f0c45a]/15 to-[#5bc2b4]/10",
        hoverBorder: "hover:border-[#f0c45a]/40",
        accentGradient: "from-[#f0c45a] to-[#5bc2b4]",
        filter: { type: "mood", value: "summer" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-focus",
        name: "Focus",
        description: "Instrumental, focused, calm",
        color: "from-[#7fa8d8]/15 to-[#5bc2b4]/10",
        hoverBorder: "hover:border-[#7fa8d8]/40",
        accentGradient: "from-[#7fa8d8] to-[#5bc2b4]",
        filter: { type: "mood", value: "focus" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-feel-good",
        name: "Feel-good",
        description: "Not sleepy, not dark, uplifting",
        color: "from-[#f0a05a]/15 to-[#e06ab0]/10",
        hoverBorder: "hover:border-[#f0a05a]/40",
        accentGradient: "from-[#f0a05a] to-[#e06ab0]",
        filter: { type: "mood", value: "feel-good" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-late-night",
        name: "Late Night",
        description: "Night-time, calm, low energy",
        color: "from-[#6f6fc4]/15 to-[#3a3f7a]/10",
        hoverBorder: "hover:border-[#6f6fc4]/40",
        accentGradient: "from-[#6f6fc4] to-[#3a3f7a]",
        filter: { type: "mood", value: "late-night" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-romantic",
        name: "Romantic",
        description: "Romantic, sad, groovy",
        color: "from-[#e0789a]/15 to-[#b98fe0]/10",
        hoverBorder: "hover:border-[#e0789a]/40",
        accentGradient: "from-[#e0789a] to-[#b98fe0]",
        filter: { type: "mood", value: "romantic" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-road-trip",
        name: "Road Trip",
        description: "Driving, uplifting, summery",
        color: "from-[#e8875a]/15 to-[#f0b25a]/10",
        hoverBorder: "hover:border-[#e8875a]/40",
        accentGradient: "from-[#e8875a] to-[#f0b25a]",
        filter: { type: "mood", value: "road-trip" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-nostalgic",
        name: "Nostalgic",
        description: "Nostalgic, high energy, happy",
        color: "from-[#d8a878]/15 to-[#b98fe0]/10",
        hoverBorder: "hover:border-[#d8a878]/40",
        accentGradient: "from-[#d8a878] to-[#b98fe0]",
        filter: { type: "mood", value: "nostalgic" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-epic",
        name: "Epic",
        description: "Epic, high energy, uplifting",
        color: "from-[#e0685e]/15 to-[#f0b25a]/10",
        hoverBorder: "hover:border-[#e0685e]/40",
        accentGradient: "from-[#e0685e] to-[#f0b25a]",
        filter: { type: "mood", value: "epic" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
    {
        id: "mood-wildcard",
        name: "Wildcard",
        description: "Songs with no mood tag",
        color: "from-[#a3a3a3]/15 to-[#6b7280]/10",
        hoverBorder: "hover:border-[#a3a3a3]/40",
        accentGradient: "from-[#a3a3a3] to-[#6b7280]",
        filter: { type: "mood", value: "wildcard" },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    },
];

const GENRE_STYLES: Record<string, { color: string; hoverBorder: string; accentGradient: string }> = {
    rock: { color: "from-[#ef4444]/15 to-[#f97316]/10", hoverBorder: "hover:border-[#ef4444]/40", accentGradient: "from-[#ef4444] to-[#f97316]" },
    pop: { color: "from-[#facc15]/15 to-[#f43f5e]/10", hoverBorder: "hover:border-[#facc15]/40", accentGradient: "from-[#facc15] to-[#f43f5e]" },
    "hip hop": { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    "hip-hop": { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    rap: { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    electronic: { color: "from-[#06b6d4]/15 to-[#3b82f6]/10", hoverBorder: "hover:border-[#06b6d4]/40", accentGradient: "from-[#06b6d4] to-[#3b82f6]" },
    jazz: { color: "from-[#f59e0b]/15 to-[#eab308]/10", hoverBorder: "hover:border-[#f59e0b]/40", accentGradient: "from-[#f59e0b] to-[#eab308]" },
    classical: { color: "from-[#94a3b8]/15 to-[#64748b]/10", hoverBorder: "hover:border-[#94a3b8]/40", accentGradient: "from-[#94a3b8] to-[#64748b]" },
    metal: { color: "from-[#71717a]/15 to-[#52525b]/10", hoverBorder: "hover:border-[#71717a]/40", accentGradient: "from-[#71717a] to-[#52525b]" },
    country: { color: "from-[#fb923c]/15 to-[#f59e0b]/10", hoverBorder: "hover:border-[#fb923c]/40", accentGradient: "from-[#fb923c] to-[#f59e0b]" },
    folk: { color: "from-[#22c55e]/15 to-[#10b981]/10", hoverBorder: "hover:border-[#22c55e]/40", accentGradient: "from-[#22c55e] to-[#10b981]" },
    indie: { color: "from-[#8b5cf6]/15 to-[#a855f7]/10", hoverBorder: "hover:border-[#8b5cf6]/40", accentGradient: "from-[#8b5cf6] to-[#a855f7]" },
    alternative: { color: "from-[#6366f1]/15 to-[#3b82f6]/10", hoverBorder: "hover:border-[#6366f1]/40", accentGradient: "from-[#6366f1] to-[#3b82f6]" },
    "r&b": { color: "from-[#c084fc]/15 to-[#7c3aed]/10", hoverBorder: "hover:border-[#c084fc]/40", accentGradient: "from-[#c084fc] to-[#7c3aed]" },
    soul: { color: "from-[#d97706]/15 to-[#ea580c]/10", hoverBorder: "hover:border-[#d97706]/40", accentGradient: "from-[#d97706] to-[#ea580c]" },
    blues: { color: "from-[#2563eb]/15 to-[#4f46e5]/10", hoverBorder: "hover:border-[#2563eb]/40", accentGradient: "from-[#2563eb] to-[#4f46e5]" },
    punk: { color: "from-[#84cc16]/15 to-[#22c55e]/10", hoverBorder: "hover:border-[#84cc16]/40", accentGradient: "from-[#84cc16] to-[#22c55e]" },
    reggae: { color: "from-[#4ade80]/15 to-[#eab308]/10", hoverBorder: "hover:border-[#4ade80]/40", accentGradient: "from-[#4ade80] to-[#eab308]" },
};

const DEFAULT_STYLE = { color: "from-[#6b7280]/15 to-[#4b5563]/10", hoverBorder: "hover:border-[#6b7280]/40", accentGradient: "from-[#6b7280] to-[#4b5563]" };

const DECADE_ACCENT_COLORS: Record<number, { color: string; hoverBorder: string; accentGradient: string }> = {
    1700: { color: "from-[#92400e]/15 to-[#78350f]/10", hoverBorder: "hover:border-[#92400e]/40", accentGradient: "from-[#92400e] to-[#78350f]" },
    1800: { color: "from-[#64748b]/15 to-[#475569]/10", hoverBorder: "hover:border-[#64748b]/40", accentGradient: "from-[#64748b] to-[#475569]" },
    1900: { color: "from-[#fbbf24]/15 to-[#f59e0b]/10", hoverBorder: "hover:border-[#fbbf24]/40", accentGradient: "from-[#fbbf24] to-[#f59e0b]" },
    1920: { color: "from-[#eab308]/15 to-[#d97706]/10", hoverBorder: "hover:border-[#eab308]/40", accentGradient: "from-[#eab308] to-[#d97706]" },
    1940: { color: "from-[#f87171]/15 to-[#fb923c]/10", hoverBorder: "hover:border-[#f87171]/40", accentGradient: "from-[#f87171] to-[#fb923c]" },
    1950: { color: "from-[#e11d48]/15 to-[#9f1239]/10", hoverBorder: "hover:border-[#e11d48]/40", accentGradient: "from-[#e11d48] to-[#9f1239]" },
    1960: { color: "from-[#f59e0b]/15 to-[#ea580c]/10", hoverBorder: "hover:border-[#f59e0b]/40", accentGradient: "from-[#f59e0b] to-[#ea580c]" },
    1970: { color: "from-[#f97316]/15 to-[#dc2626]/10", hoverBorder: "hover:border-[#f97316]/40", accentGradient: "from-[#f97316] to-[#dc2626]" },
    1980: { color: "from-[#22d3ee]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#22d3ee]/40", accentGradient: "from-[#22d3ee] to-[#6366f1]" },
    1990: { color: "from-[#a855f7]/15 to-[#7c3aed]/10", hoverBorder: "hover:border-[#a855f7]/40", accentGradient: "from-[#a855f7] to-[#7c3aed]" },
    2000: { color: "from-[#3b82f6]/15 to-[#06b6d4]/10", hoverBorder: "hover:border-[#3b82f6]/40", accentGradient: "from-[#3b82f6] to-[#06b6d4]" },
    2010: { color: "from-[#14b8a6]/15 to-[#10b981]/10", hoverBorder: "hover:border-[#14b8a6]/40", accentGradient: "from-[#14b8a6] to-[#10b981]" },
    2020: { color: "from-[#f97316]/15 to-[#d97706]/10", hoverBorder: "hover:border-[#f97316]/40", accentGradient: "from-[#f97316] to-[#d97706]" },
};

function getGenreStyle(genre: string) {
    return GENRE_STYLES[genre.toLowerCase()] || DEFAULT_STYLE;
}

function getDecadeStyle(decade: number) {
    const knownDecades = Object.keys(DECADE_ACCENT_COLORS).map(Number).sort((a, b) => b - a);
    for (const known of knownDecades) {
        if (decade >= known) return DECADE_ACCENT_COLORS[known];
    }
    return DEFAULT_STYLE;
}

function getDecadeName(decade: number): string {
    if (decade < 1900) return `${decade}s`;
    if (decade < 2000) return `${decade.toString().slice(2)}s`;
    return `${decade}s`;
}

export function useRadioPlayer() {
    const { playStation } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);

    const startRadio = async (station: RadioStation) => {
        setLoadingStation(station.id);
        try {
            const params = new URLSearchParams();
            params.set("type", station.filter.type);
            if (station.filter.value) params.set("value", station.filter.value);
            params.set("limit", "100");

            // Played in the server's order (stationBatches).
            const fetchTracks = stationBatches(
                (query) => api.get<{ tracks: Track[]; next?: number }>(`/library/radio?${query}`),
                params
            );
            const response = await fetchTracks();

            if (!response.tracks || response.tracks.length === 0) {
                notify.error("No tracks for this radio station", { message: station.name });
                return;
            }
            if (response.tracks.length < (station.minTracks || 10)) {
                notify.error("Not enough tracks for this radio station", {
                    message: `${station.name}: found ${response.tracks.length}, needs ${station.minTracks || 10}`,
                });
                return;
            }

            playStation(response.tracks, async () => (await fetchTracks()).tracks ?? [], {
                serverOrdered: response.next !== undefined,
            });
        } catch (error) {
            console.error("Failed to start radio:", error);
            notify.error("Failed to start radio station");
        } finally {
            setLoadingStation(null);
        }
    };

    return { loadingStation, startRadio };
}

/** The stations this server can play: the mood-built ones only where the vibe analyzer runs. */
export function playableStations(stations: RadioStation[], moodsAvailable: boolean): RadioStation[] {
    return moodsAvailable ? stations : stations.filter((station) => !station.needsMoods);
}

export function buildGenreStations(genres: GenreCount[]): RadioStation[] {
    return genres.map((g) => {
        const style = getGenreStyle(g.genre);
        return {
            id: `genre-${g.genre}`,
            name: g.genre,
            description: plural(g.count, "track"),
            ...style,
            filter: { type: "genre" as const, value: g.genre },
            minTracks: 15,
        };
    });
}

export function buildDecadeStations(decades: DecadeCount[]): RadioStation[] {
    return decades.map((d) => {
        const style = getDecadeStyle(d.decade);
        return {
            id: `decade-${d.decade}`,
            name: getDecadeName(d.decade),
            description: plural(d.count, "track"),
            ...style,
            filter: { type: "decade" as const, value: d.decade.toString() },
            minTracks: 15,
        };
    });
}
