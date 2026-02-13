import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { shuffleArray } from "@/utils/shuffle";
import { toast } from "sonner";
import { Shuffle } from "lucide-react";
import { createElement, useState } from "react";

export interface RadioStation {
    id: string;
    name: string;
    description: string;
    color: string;
    hoverBorder: string;
    hoverShadow: string;
    accentGradient: string;
    filter: {
        type: "genre" | "decade" | "discovery" | "favorites" | "all" | "workout";
        value?: string;
    };
    minTracks?: number;
}

export interface GenreCount {
    genre: string;
    count: number;
}

export interface DecadeCount {
    decade: number;
    count: number;
}

export const STATIC_STATIONS: RadioStation[] = [
    {
        id: "all",
        name: "Shuffle All",
        description: "Your entire library",
        color: "from-[#fca208]/15 to-[#f97316]/10",
        hoverBorder: "hover:border-[#fca208]/40",
        hoverShadow: "hover:shadow-[#fca208]/10",
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
        hoverShadow: "hover:shadow-[#ef4444]/10",
        accentGradient: "from-[#ef4444] to-[#f97316]",
        filter: { type: "workout" },
        minTracks: 15,
    },
    {
        id: "discovery",
        name: "Discovery",
        description: "Lesser-played gems",
        color: "from-[#22c55e]/15 to-[#14b8a6]/10",
        hoverBorder: "hover:border-[#22c55e]/40",
        hoverShadow: "hover:shadow-[#22c55e]/10",
        accentGradient: "from-[#22c55e] to-[#14b8a6]",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: "Favorites",
        description: "Most played",
        color: "from-[#ec4899]/15 to-[#db2777]/10",
        hoverBorder: "hover:border-[#ec4899]/40",
        hoverShadow: "hover:shadow-[#ec4899]/10",
        accentGradient: "from-[#ec4899] to-[#db2777]",
        filter: { type: "favorites" },
        minTracks: 10,
    },
];

const GENRE_STYLES: Record<string, { color: string; hoverBorder: string; hoverShadow: string; accentGradient: string }> = {
    rock: { color: "from-[#ef4444]/15 to-[#f97316]/10", hoverBorder: "hover:border-[#ef4444]/40", hoverShadow: "hover:shadow-[#ef4444]/10", accentGradient: "from-[#ef4444] to-[#f97316]" },
    pop: { color: "from-[#ec4899]/15 to-[#f43f5e]/10", hoverBorder: "hover:border-[#ec4899]/40", hoverShadow: "hover:shadow-[#ec4899]/10", accentGradient: "from-[#ec4899] to-[#f43f5e]" },
    "hip hop": { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", hoverShadow: "hover:shadow-[#a855f7]/10", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    "hip-hop": { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", hoverShadow: "hover:shadow-[#a855f7]/10", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    rap: { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", hoverShadow: "hover:shadow-[#a855f7]/10", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    electronic: { color: "from-[#06b6d4]/15 to-[#3b82f6]/10", hoverBorder: "hover:border-[#06b6d4]/40", hoverShadow: "hover:shadow-[#06b6d4]/10", accentGradient: "from-[#06b6d4] to-[#3b82f6]" },
    jazz: { color: "from-[#f59e0b]/15 to-[#eab308]/10", hoverBorder: "hover:border-[#f59e0b]/40", hoverShadow: "hover:shadow-[#f59e0b]/10", accentGradient: "from-[#f59e0b] to-[#eab308]" },
    classical: { color: "from-[#94a3b8]/15 to-[#64748b]/10", hoverBorder: "hover:border-[#94a3b8]/40", hoverShadow: "hover:shadow-[#94a3b8]/10", accentGradient: "from-[#94a3b8] to-[#64748b]" },
    metal: { color: "from-[#71717a]/15 to-[#52525b]/10", hoverBorder: "hover:border-[#71717a]/40", hoverShadow: "hover:shadow-[#71717a]/10", accentGradient: "from-[#71717a] to-[#52525b]" },
    country: { color: "from-[#fb923c]/15 to-[#f59e0b]/10", hoverBorder: "hover:border-[#fb923c]/40", hoverShadow: "hover:shadow-[#fb923c]/10", accentGradient: "from-[#fb923c] to-[#f59e0b]" },
    folk: { color: "from-[#22c55e]/15 to-[#10b981]/10", hoverBorder: "hover:border-[#22c55e]/40", hoverShadow: "hover:shadow-[#22c55e]/10", accentGradient: "from-[#22c55e] to-[#10b981]" },
    indie: { color: "from-[#8b5cf6]/15 to-[#a855f7]/10", hoverBorder: "hover:border-[#8b5cf6]/40", hoverShadow: "hover:shadow-[#8b5cf6]/10", accentGradient: "from-[#8b5cf6] to-[#a855f7]" },
    alternative: { color: "from-[#6366f1]/15 to-[#3b82f6]/10", hoverBorder: "hover:border-[#6366f1]/40", hoverShadow: "hover:shadow-[#6366f1]/10", accentGradient: "from-[#6366f1] to-[#3b82f6]" },
    "r&b": { color: "from-[#d946ef]/15 to-[#ec4899]/10", hoverBorder: "hover:border-[#d946ef]/40", hoverShadow: "hover:shadow-[#d946ef]/10", accentGradient: "from-[#d946ef] to-[#ec4899]" },
    soul: { color: "from-[#d97706]/15 to-[#ea580c]/10", hoverBorder: "hover:border-[#d97706]/40", hoverShadow: "hover:shadow-[#d97706]/10", accentGradient: "from-[#d97706] to-[#ea580c]" },
    blues: { color: "from-[#2563eb]/15 to-[#4f46e5]/10", hoverBorder: "hover:border-[#2563eb]/40", hoverShadow: "hover:shadow-[#2563eb]/10", accentGradient: "from-[#2563eb] to-[#4f46e5]" },
    punk: { color: "from-[#84cc16]/15 to-[#22c55e]/10", hoverBorder: "hover:border-[#84cc16]/40", hoverShadow: "hover:shadow-[#84cc16]/10", accentGradient: "from-[#84cc16] to-[#22c55e]" },
    reggae: { color: "from-[#4ade80]/15 to-[#eab308]/10", hoverBorder: "hover:border-[#4ade80]/40", hoverShadow: "hover:shadow-[#4ade80]/10", accentGradient: "from-[#4ade80] to-[#eab308]" },
};

const DEFAULT_STYLE = { color: "from-[#6b7280]/15 to-[#4b5563]/10", hoverBorder: "hover:border-[#6b7280]/40", hoverShadow: "hover:shadow-[#6b7280]/10", accentGradient: "from-[#6b7280] to-[#4b5563]" };

const DECADE_ACCENT_COLORS: Record<number, { color: string; hoverBorder: string; hoverShadow: string; accentGradient: string }> = {
    1700: { color: "from-[#92400e]/15 to-[#78350f]/10", hoverBorder: "hover:border-[#92400e]/40", hoverShadow: "hover:shadow-[#92400e]/10", accentGradient: "from-[#92400e] to-[#78350f]" },
    1800: { color: "from-[#64748b]/15 to-[#475569]/10", hoverBorder: "hover:border-[#64748b]/40", hoverShadow: "hover:shadow-[#64748b]/10", accentGradient: "from-[#64748b] to-[#475569]" },
    1900: { color: "from-[#fbbf24]/15 to-[#f59e0b]/10", hoverBorder: "hover:border-[#fbbf24]/40", hoverShadow: "hover:shadow-[#fbbf24]/10", accentGradient: "from-[#fbbf24] to-[#f59e0b]" },
    1920: { color: "from-[#eab308]/15 to-[#d97706]/10", hoverBorder: "hover:border-[#eab308]/40", hoverShadow: "hover:shadow-[#eab308]/10", accentGradient: "from-[#eab308] to-[#d97706]" },
    1940: { color: "from-[#f87171]/15 to-[#fb923c]/10", hoverBorder: "hover:border-[#f87171]/40", hoverShadow: "hover:shadow-[#f87171]/10", accentGradient: "from-[#f87171] to-[#fb923c]" },
    1950: { color: "from-[#f472b6]/15 to-[#ef4444]/10", hoverBorder: "hover:border-[#f472b6]/40", hoverShadow: "hover:shadow-[#f472b6]/10", accentGradient: "from-[#f472b6] to-[#ef4444]" },
    1960: { color: "from-[#f59e0b]/15 to-[#ea580c]/10", hoverBorder: "hover:border-[#f59e0b]/40", hoverShadow: "hover:shadow-[#f59e0b]/10", accentGradient: "from-[#f59e0b] to-[#ea580c]" },
    1970: { color: "from-[#f97316]/15 to-[#dc2626]/10", hoverBorder: "hover:border-[#f97316]/40", hoverShadow: "hover:shadow-[#f97316]/10", accentGradient: "from-[#f97316] to-[#dc2626]" },
    1980: { color: "from-[#d946ef]/15 to-[#9333ea]/10", hoverBorder: "hover:border-[#d946ef]/40", hoverShadow: "hover:shadow-[#d946ef]/10", accentGradient: "from-[#d946ef] to-[#9333ea]" },
    1990: { color: "from-[#a855f7]/15 to-[#7c3aed]/10", hoverBorder: "hover:border-[#a855f7]/40", hoverShadow: "hover:shadow-[#a855f7]/10", accentGradient: "from-[#a855f7] to-[#7c3aed]" },
    2000: { color: "from-[#3b82f6]/15 to-[#06b6d4]/10", hoverBorder: "hover:border-[#3b82f6]/40", hoverShadow: "hover:shadow-[#3b82f6]/10", accentGradient: "from-[#3b82f6] to-[#06b6d4]" },
    2010: { color: "from-[#14b8a6]/15 to-[#10b981]/10", hoverBorder: "hover:border-[#14b8a6]/40", hoverShadow: "hover:shadow-[#14b8a6]/10", accentGradient: "from-[#14b8a6] to-[#10b981]" },
    2020: { color: "from-[#f97316]/15 to-[#d97706]/10", hoverBorder: "hover:border-[#f97316]/40", hoverShadow: "hover:shadow-[#f97316]/10", accentGradient: "from-[#f97316] to-[#d97706]" },
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
    const { playTracks } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);

    const startRadio = async (station: RadioStation) => {
        setLoadingStation(station.id);
        try {
            const params = new URLSearchParams();
            params.set("type", station.filter.type);
            if (station.filter.value) params.set("value", station.filter.value);
            params.set("limit", "100");

            const response = await api.get<{ tracks: Track[] }>(
                `/library/radio?${params.toString()}`
            );

            if (!response.tracks || response.tracks.length === 0) {
                toast.error(`No tracks found for ${station.name}`);
                return;
            }
            if (response.tracks.length < (station.minTracks || 10)) {
                toast.error(`Not enough tracks for ${station.name} radio`, {
                    description: `Found ${response.tracks.length}, need at least ${station.minTracks || 10}`,
                });
                return;
            }

            const shuffled = shuffleArray(response.tracks);
            playTracks(shuffled, 0);
            toast.success(`${station.name} Radio`, {
                description: `Shuffling ${shuffled.length} tracks`,
                icon: createElement(Shuffle, { className: "w-4 h-4" }),
            });
        } catch (error) {
            console.error("Failed to start radio:", error);
            toast.error("Failed to start radio station");
        } finally {
            setLoadingStation(null);
        }
    };

    return { loadingStation, startRadio };
}

export function buildGenreStations(genres: GenreCount[]): RadioStation[] {
    return genres.map((g) => {
        const style = getGenreStyle(g.genre);
        return {
            id: `genre-${g.genre}`,
            name: g.genre,
            description: `${g.count} tracks`,
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
            description: `${d.count} tracks`,
            ...style,
            filter: { type: "decade" as const, value: d.decade.toString() },
            minTracks: 15,
        };
    });
}
