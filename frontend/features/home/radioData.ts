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
    minTracks: number;
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

/** One mood station as the server lists it (GET /library/radio/stations): its subtitle is generated from its recipe. */
export interface MoodStationInfo {
    value: string;
    name: string;
    description: string;
}

/**
 * Each mood station's tile colours, from the vibe map's muted mood palette (features/vibe/mapUtils.ts), written out in
 * full so Tailwind finds the classes. A station the server adds later plays in the default colours until it has a row.
 */
const MOOD_STATION_STYLES: Record<string, { color: string; hoverBorder: string; accentGradient: string }> = {
    "calm": { color: "from-[#5bc2b4]/15 to-[#3f8f9c]/10", hoverBorder: "hover:border-[#5bc2b4]/40", accentGradient: "from-[#5bc2b4] to-[#3f8f9c]" },
    "energy": { color: "from-[#e06ab0]/15 to-[#f0905a]/10", hoverBorder: "hover:border-[#e06ab0]/40", accentGradient: "from-[#e06ab0] to-[#f0905a]" },
    "intense": { color: "from-[#e0685e]/15 to-[#8c3a4a]/10", hoverBorder: "hover:border-[#e0685e]/40", accentGradient: "from-[#e0685e] to-[#8c3a4a]" },
    "happy": { color: "from-[#f0b25a]/15 to-[#e8875a]/10", hoverBorder: "hover:border-[#f0b25a]/40", accentGradient: "from-[#f0b25a] to-[#e8875a]" },
    "melancholy": { color: "from-[#b98fe0]/15 to-[#6f6fc4]/10", hoverBorder: "hover:border-[#b98fe0]/40", accentGradient: "from-[#b98fe0] to-[#6f6fc4]" },
    "focus-calm": { color: "from-[#7fa8d8]/15 to-[#5bc2b4]/10", hoverBorder: "hover:border-[#7fa8d8]/40", accentGradient: "from-[#7fa8d8] to-[#5bc2b4]" },
    "focus-energy": { color: "from-[#7fa8d8]/15 to-[#e06ab0]/10", hoverBorder: "hover:border-[#7fa8d8]/40", accentGradient: "from-[#7fa8d8] to-[#e06ab0]" },
    "feel-good": { color: "from-[#f0a05a]/15 to-[#e06ab0]/10", hoverBorder: "hover:border-[#f0a05a]/40", accentGradient: "from-[#f0a05a] to-[#e06ab0]" },
    "late-night": { color: "from-[#6f6fc4]/15 to-[#3a3f7a]/10", hoverBorder: "hover:border-[#6f6fc4]/40", accentGradient: "from-[#6f6fc4] to-[#3a3f7a]" },
    "romantic": { color: "from-[#e0789a]/15 to-[#b98fe0]/10", hoverBorder: "hover:border-[#e0789a]/40", accentGradient: "from-[#e0789a] to-[#b98fe0]" },
    "road-trip": { color: "from-[#e8875a]/15 to-[#f0b25a]/10", hoverBorder: "hover:border-[#e8875a]/40", accentGradient: "from-[#e8875a] to-[#f0b25a]" },
    "nostalgic": { color: "from-[#d8a878]/15 to-[#b98fe0]/10", hoverBorder: "hover:border-[#d8a878]/40", accentGradient: "from-[#d8a878] to-[#b98fe0]" },
    "epic": { color: "from-[#e0685e]/15 to-[#f0b25a]/10", hoverBorder: "hover:border-[#e0685e]/40", accentGradient: "from-[#e0685e] to-[#f0b25a]" },
    "wildcard": { color: "from-[#a3a3a3]/15 to-[#6b7280]/10", hoverBorder: "hover:border-[#a3a3a3]/40", accentGradient: "from-[#a3a3a3] to-[#6b7280]" },
};

/** The server's mood stations as tiles, in its order. */
export function buildMoodStations(stations: MoodStationInfo[]): RadioStation[] {
    return stations.map(({ value, name, description }) => ({
        id: `mood-${value}`,
        name,
        description,
        ...(MOOD_STATION_STYLES[value] ?? DEFAULT_STYLE),
        filter: { type: "mood" as const, value },
        minTracks: STATION_MIN_TRACKS,
        needsMoods: true,
    }));
}

const GENRE_STYLES: Record<string, { color: string; hoverBorder: string; accentGradient: string }> = {
    rock: { color: "from-[#ef4444]/15 to-[#f97316]/10", hoverBorder: "hover:border-[#ef4444]/40", accentGradient: "from-[#ef4444] to-[#f97316]" },
    pop: { color: "from-[#facc15]/15 to-[#f43f5e]/10", hoverBorder: "hover:border-[#facc15]/40", accentGradient: "from-[#facc15] to-[#f43f5e]" },
    "hip hop": { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    rap: { color: "from-[#a855f7]/15 to-[#6366f1]/10", hoverBorder: "hover:border-[#a855f7]/40", accentGradient: "from-[#a855f7] to-[#6366f1]" },
    electronic: { color: "from-[#06b6d4]/15 to-[#3b82f6]/10", hoverBorder: "hover:border-[#06b6d4]/40", accentGradient: "from-[#06b6d4] to-[#3b82f6]" },
    jazz: { color: "from-[#f59e0b]/15 to-[#eab308]/10", hoverBorder: "hover:border-[#f59e0b]/40", accentGradient: "from-[#f59e0b] to-[#eab308]" },
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

export const DEFAULT_STYLE = { color: "from-[#6b7280]/15 to-[#4b5563]/10", hoverBorder: "hover:border-[#6b7280]/40", accentGradient: "from-[#6b7280] to-[#4b5563]" };

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

/** A genre name as the server keys it (genreKeySql in backend/src/utils/genreSql.ts), so every spelling gets one colour. */
const genreKey = (genre: string) =>
    genre
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\s\u00a0\u202f\u00ad\u200b\ufeff_/.\u00b7'\u2018\u2019\u2010-\u2015\u2043\u2212-]+/g, "");

const GENRE_STYLES_BY_KEY = new Map(Object.entries(GENRE_STYLES).map(([name, style]) => [genreKey(name), style]));

/** The mood stations' colours, minus Wildcard's grey: the colours a genre without its own is given. */
const SPARE_GENRE_STYLES = Object.entries(MOOD_STATION_STYLES)
    .filter(([mood]) => mood !== "wildcard")
    .map(([, style]) => style);

/** A genre's colour: its own if it has one, otherwise one of the spare colours, picked from its name so it never changes. */
function getGenreStyle(genre: string) {
    const key = genreKey(genre);
    const own = GENRE_STYLES_BY_KEY.get(key);
    if (own) return own;
    let hash = 0;
    for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
    return SPARE_GENRE_STYLES[hash % SPARE_GENRE_STYLES.length];
}

function getDecadeStyle(decade: number) {
    const knownDecades = Object.keys(DECADE_ACCENT_COLORS).map(Number).sort((a, b) => b - a);
    for (const known of knownDecades) {
        if (decade >= known) return DECADE_ACCENT_COLORS[known];
    }
    return DEFAULT_STYLE;
}

/** The twentieth century's decades by two digits ("80s"), every other by four ("1850s", "2010s"). */
function getDecadeName(decade: number): string {
    return decade >= 1900 && decade < 2000 ? `${decade.toString().slice(2)}s` : `${decade}s`;
}

/** The request a station plays from (GET /library/radio): its type and value, and how many songs. */
export function stationParams(station: RadioStation, limit: number): URLSearchParams {
    const params = new URLSearchParams();
    params.set("type", station.filter.type);
    if (station.filter.value) params.set("value", station.filter.value);
    params.set("limit", String(limit));
    // Late Night plays this listener's own songs from after dark, read in their time zone.
    params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
    return params;
}

/** How the server and the page name a station when matching covers to tiles. */
const coverKey = (type: string, value?: string | null) => `${type}:${value ?? ""}`;

/** The stations a page shows, as the cover request lists them. */
export function coverRequest(stations: RadioStation[]): { type: string; value?: string }[] {
    return stations.map((station) => ({ type: station.filter.type, ...(station.filter.value ? { value: station.filter.value } : {}) }));
}

/** Each station's cover from the server's reply, by station id; a station the reply does not mention has none. */
export function coversByStation(
    stations: RadioStation[],
    reply: { covers: { type: string; value: string | null; cover: string | null }[] },
): Map<string, string | null> {
    const byKey = new Map(reply.covers.map((c) => [coverKey(c.type, c.value), c.cover]));
    return new Map(stations.map((s) => [s.id, byKey.get(coverKey(s.filter.type, s.filter.value)) ?? null]));
}

/** A station's colour: the first in its accent (every style above writes it as `from-[#hex] to-[#hex]`). */
export function stationHue(station: RadioStation): string {
    return station.accentGradient.match(/#[0-9a-f]{6}/i)![0];
}

export function useRadioPlayer() {
    const { playStation } = useAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);

    const startRadio = async (station: RadioStation) => {
        setLoadingStation(station.id);
        try {
            // Played in the server's order (stationBatches).
            const fetchTracks = stationBatches(
                (query) => api.get<{ tracks: Track[]; next?: number }>(`/library/radio?${query}`),
                stationParams(station, 100)
            );
            const response = await fetchTracks();

            if (!response.tracks || response.tracks.length === 0) {
                notify.error("No tracks for this radio station", { message: station.name });
                return;
            }
            if (response.tracks.length < station.minTracks) {
                notify.error("Not enough tracks for this radio station", {
                    message: `${station.name}: found ${response.tracks.length}, needs ${station.minTracks}`,
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
