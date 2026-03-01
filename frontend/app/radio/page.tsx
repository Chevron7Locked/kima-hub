"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radio, Play, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import {
    GenreCount,
    DecadeCount,
    STATIC_STATIONS,
    buildGenreStations,
    buildDecadeStations,
    useRadioPlayer,
} from "@/features/home/radioData";
import type { RadioStation } from "@/features/home/radioData";

function RadioStationCard({
    station,
    loadingStation,
    onPlay,
}: {
    station: RadioStation;
    loadingStation: string | null;
    onPlay: () => void;
}) {
    return (
        <button
            onClick={onPlay}
            disabled={loadingStation !== null}
            className={cn(
                "relative group w-full overflow-hidden",
                "aspect-[4/3] rounded-lg",
                "bg-[#0a0a0a] border-2 border-white/10",
                station.hoverBorder,
                "transition-all duration-300",
                "hover:shadow-lg",
                station.hoverShadow,
                "hover:scale-[1.02] active:scale-[0.98]",
                "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
        >
            {/* Subtle gradient tint */}
            <div className={cn("absolute inset-0 bg-gradient-to-br", station.color)} />

            {/* Content */}
            <div className="absolute inset-0 p-4 flex flex-col justify-between">
                <div className="flex items-center gap-1.5">
                    <Radio className="w-3.5 h-3.5 text-white/50" />
                    <span className="text-[9px] font-mono text-white/50 uppercase tracking-wider">
                        Radio
                    </span>
                </div>
                <div>
                    <h3 className="text-base font-black text-white truncate tracking-tight leading-tight mb-1">
                        {station.name}
                    </h3>
                    <p className="text-xs font-mono text-gray-500 uppercase tracking-wider truncate">
                        {station.description}
                    </p>
                </div>
            </div>

            {/* Bottom accent bar on hover */}
            <div className={cn(
                "absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r",
                station.accentGradient,
                "transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150 origin-center"
            )} />

            {/* Loading overlay */}
            {loadingStation === station.id && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
                    <Loader2 className="w-6 h-6 text-white animate-spin" />
                </div>
            )}

            {/* Play overlay on hover */}
            {loadingStation !== station.id && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="w-12 h-12 rounded-lg bg-white flex items-center justify-center shadow-xl">
                        <Play className="w-5 h-5 text-black ml-0.5" fill="currentColor" />
                    </div>
                </div>
            )}
        </button>
    );
}

function SectionSkeleton() {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] rounded-lg bg-[#0a0a0a] border-2 border-white/10 animate-pulse" />
            ))}
        </div>
    );
}

export default function RadioPage() {
    const { loadingStation, startRadio } = useRadioPlayer();

    const { data: genresData, isLoading: genresLoading } = useQuery({
        queryKey: ["library", "genres"],
        queryFn: () => api.get<{ genres: GenreCount[] }>("/library/genres"),
        staleTime: 5 * 60 * 1000,
        select: (data) => (data.genres || []).filter((g) => g.count >= 15),
    });

    const { data: decadesData, isLoading: decadesLoading } = useQuery({
        queryKey: ["library", "decades"],
        queryFn: () => api.get<{ decades: DecadeCount[] }>("/library/decades"),
        staleTime: 5 * 60 * 1000,
        select: (data) => data.decades || [],
    });

    const isLoading = genresLoading || decadesLoading;

    const genreStations = useMemo(() => buildGenreStations(genresData ?? []), [genresData]);
    const decadeStations = useMemo(() => buildDecadeStations(decadesData ?? []), [decadesData]);

    return (
        <div className="min-h-screen relative bg-gradient-to-b from-[#0a0a0a] to-black">
            {/* Static gradient overlay */}
            <div className="fixed inset-0 pointer-events-none opacity-50">
                <div className="absolute inset-0 bg-gradient-to-br from-white/5 via-transparent to-transparent" />
            </div>

            <div className="relative">
                {/* Hero Header */}
                <div className="relative bg-gradient-to-b from-[#0a0a0a] via-[#0f0f0f] to-transparent pt-6 pb-8 px-4 sm:px-6 md:px-8 border-b border-white/5">
                    <div className="max-w-[1800px] mx-auto">
                        {/* System status */}
                        <div className="flex items-center gap-2 mb-6">
                            <div className="w-1.5 h-1.5 bg-[#fca208] rounded-full" />
                            <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                                Radio Active
                            </span>
                        </div>

                        <div className="flex items-baseline justify-between flex-wrap gap-4">
                            <div>
                                <h1 className="text-5xl md:text-6xl lg:text-7xl font-black tracking-tighter text-white leading-none mb-3">
                                    LIBRARY<br />
                                    <span className="text-[#fca208]">RADIO</span>
                                </h1>
                                <p className="text-sm font-mono text-gray-500">
                                    Continuous shuffle from your personal archive
                                </p>
                            </div>

                            {/* Stats */}
                            <div className="flex items-center gap-4">
                                {!isLoading && (
                                    <>
                                        <div className="border-2 border-white/10 bg-[#0a0a0a] px-4 py-3 rounded">
                                            <span className="text-3xl font-black font-mono text-[#fca208]">
                                                {STATIC_STATIONS.length + genreStations.length + decadeStations.length}
                                            </span>
                                            <span className="text-xs font-mono text-gray-500 uppercase ml-2">
                                                stations
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 md:px-8 pb-32 pt-8">
                    <div className="space-y-12">
                        {/* Quick Start */}
                        <section>
                            <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                <span className="w-1 h-8 bg-gradient-to-b from-[#fca208] to-[#f97316] rounded-full" />
                                <span className="uppercase tracking-tighter">Quick Start</span>
                                <span className="flex-1 border-t border-white/10" />
                            </h2>
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                {STATIC_STATIONS.map((station) => (
                                    <RadioStationCard
                                        key={station.id}
                                        station={station}
                                        loadingStation={loadingStation}
                                        onPlay={() => startRadio(station)}
                                    />
                                ))}
                            </div>
                        </section>

                        {/* Genres */}
                        {(isLoading || genreStations.length > 0) && (
                            <section>
                                <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                    <span className="w-1 h-8 bg-gradient-to-b from-[#a855f7] to-[#c026d3] rounded-full" />
                                    <span className="uppercase tracking-tighter">By Genre</span>
                                    <span className="flex-1 border-t border-white/10" />
                                    {!isLoading && (
                                        <span className="text-xs font-mono text-[#a855f7]">
                                            {genreStations.length} genres
                                        </span>
                                    )}
                                </h2>
                                {isLoading ? (
                                    <SectionSkeleton />
                                ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                        {genreStations.map((station) => (
                                            <RadioStationCard
                                                key={station.id}
                                                station={station}
                                                loadingStation={loadingStation}
                                                onPlay={() => startRadio(station)}
                                            />
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}

                        {/* Decades */}
                        {(isLoading || decadeStations.length > 0) && (
                            <section>
                                <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 mb-6">
                                    <span className="w-1 h-8 bg-gradient-to-b from-[#22c55e] to-[#16a34a] rounded-full" />
                                    <span className="uppercase tracking-tighter">By Decade</span>
                                    <span className="flex-1 border-t border-white/10" />
                                    {!isLoading && (
                                        <span className="text-xs font-mono text-[#22c55e]">
                                            {decadeStations.length} decades
                                        </span>
                                    )}
                                </h2>
                                {isLoading ? (
                                    <SectionSkeleton />
                                ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                        {decadeStations.map((station) => (
                                            <RadioStationCard
                                                key={station.id}
                                                station={station}
                                                loadingStation={loadingStation}
                                                onPlay={() => startRadio(station)}
                                            />
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}

                        {/* Info panel */}
                        <section>
                            <div className="relative overflow-hidden rounded-lg border-2 border-white/10 bg-gradient-to-br from-[#0f0f0f] to-[#0a0a0a] p-8">
                                <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-[#fca208] to-[#f97316]" />
                                <div className="flex items-center gap-3 mb-4 pb-3 border-b border-white/10">
                                    <div className="w-2 h-2 bg-[#fca208]" />
                                    <span className="text-xs font-mono text-white/60 uppercase tracking-wider">
                                        How It Works
                                    </span>
                                </div>
                                <h3 className="text-xl font-black tracking-tighter text-white mb-3">
                                    PERSONALIZED RADIO
                                </h3>
                                <p className="text-sm font-mono text-gray-500 leading-relaxed max-w-2xl">
                                    Radio stations are generated from your personal music library. As you add more music,
                                    new genre and decade stations will automatically appear. Each station requires a minimum
                                    number of tracks to ensure a good listening experience.
                                </p>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}
