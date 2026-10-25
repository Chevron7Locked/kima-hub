"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { TileCard } from "@/components/cards/TileCard";
import {
    GenreCount,
    DecadeCount,
    RadioStation,
    STATIC_STATIONS,
    MOOD_STATIONS,
    buildGenreStations,
    playableStations,
    buildDecadeStations,
    useRadioPlayer,
} from "@/features/home/radioData";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/layout/PageHeader";
import { useFeatures } from "@/lib/features-context";

function SectionSkeleton() {
    return (
        <div className="grid-media">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
            ))}
        </div>
    );
}

interface StationGridProps {
    stations: RadioStation[];
    loadingStation: string | null;
    onStart: (station: RadioStation) => void;
}

function StationGrid({ stations, loadingStation, onStart }: StationGridProps) {
    return (
        <div className="grid-media">
            {stations.map((station) => (
                <TileCard
                    key={station.id}
                    title={station.name}
                    subtitle={station.description}
                    wrapSubtitle
                    tint={station.color}
                    hoverBorder={station.hoverBorder}
                    accent={station.accentGradient}
                    onClick={() => onStart(station)}
                    playable
                    busy={loadingStation === station.id}
                    disabled={loadingStation !== null}
                    className="w-full aspect-[4/3]"
                />
            ))}
        </div>
    );
}

interface StationSectionProps extends Omit<StationGridProps, "stations"> {
    title: string;
    unit: string;
    noun: string;
    stations: RadioStation[];
    isLoading: boolean;
    isError: boolean;
    onRetry: () => void;
}

function StationSection({ title, unit, noun, stations, isLoading, isError, onRetry, ...grid }: StationSectionProps) {
    if (!isLoading && !isError && stations.length === 0) return null;

    return (
        <section>
            <SectionHeader
                type="track"
                title={title}
                count={!isLoading && !isError ? `${stations.length} ${unit}` : undefined}
            />
            {isLoading ? (
                <SectionSkeleton />
            ) : isError ? (
                <div className="flex items-center gap-3 py-4">
                    <p className="text-sm text-[var(--text-secondary)]">
                        Could not load {noun} stations.
                    </p>
                    <Button onClick={onRetry} aria-label={`Retry loading ${noun} stations`}>
                        Retry
                    </Button>
                </div>
            ) : (
                <StationGrid stations={stations} {...grid} />
            )}
        </section>
    );
}

export default function RadioPage() {
    const { loadingStation, startRadio } = useRadioPlayer();
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();

    const { data: genresData, isLoading: genresLoading, isError: genresError, refetch: refetchGenres } = useQuery({
        queryKey: ["library", "genres"],
        queryFn: () => api.get<{ genres: GenreCount[] }>("/library/genres"),
        staleTime: 5 * 60 * 1000,
        select: (data) => (data.genres || []).filter((g) => g.count >= 15),
    });

    const { data: decadesData, isLoading: decadesLoading, isError: decadesError, refetch: refetchDecades } = useQuery({
        queryKey: ["library", "decades"],
        queryFn: () => api.get<{ decades: DecadeCount[] }>("/library/decades"),
        staleTime: 5 * 60 * 1000,
        select: (data) => data.decades || [],
    });

    const isLoading = genresLoading || decadesLoading;

    const quickStations = useMemo(() => playableStations(STATIC_STATIONS, vibeEmbeddings), [vibeEmbeddings]);
    const moodStations = useMemo(() => playableStations(MOOD_STATIONS, vibeEmbeddings), [vibeEmbeddings]);

    const genreStations = useMemo(() => buildGenreStations(genresData ?? []), [genresData]);
    const decadeStations = useMemo(() => buildDecadeStations(decadesData ?? []), [decadesData]);

    return (
        <div className="min-h-screen">
            <div className="relative">
                <PageHeader
                    eyebrow="Your library"
                    title="Radio"
                    description={
                        isLoading || featuresLoading
                            ? "Endless shuffles from your own music"
                            : `${quickStations.length + moodStations.length + genreStations.length + decadeStations.length} stations, each an endless shuffle from your own music`
                    }
                />

                <div className="relative page-shell pb-32 pt-2 animate-rise">
                    <div className="section-stack">
                        <section>
                            <SectionHeader title="Quick Start" />
                            {/* Workout waits on the feature check too, so it does not pop in after the others. */}
                            {featuresLoading ? (
                                <SectionSkeleton />
                            ) : (
                                <StationGrid stations={quickStations} loadingStation={loadingStation} onStart={startRadio} />
                            )}
                        </section>

                        <StationSection
                            title="By Mood"
                            unit="stations"
                            noun="mood"
                            stations={moodStations}
                            isLoading={featuresLoading}
                            isError={false}
                            onRetry={() => {}}
                            loadingStation={loadingStation}
                            onStart={startRadio}
                        />

                        <StationSection
                            title="By Genre"
                            unit="genres"
                            noun="genre"
                            stations={genreStations}
                            isLoading={isLoading}
                            isError={genresError}
                            onRetry={() => refetchGenres()}
                            loadingStation={loadingStation}
                            onStart={startRadio}
                        />

                        <StationSection
                            title="By Decade"
                            unit="decades"
                            noun="decade"
                            stations={decadeStations}
                            isLoading={isLoading}
                            isError={decadesError}
                            onRetry={() => refetchDecades()}
                            loadingStation={loadingStation}
                            onStart={startRadio}
                        />

                        <p className="t-meta">
                            Genre and decade stations appear once your library has enough tracks for them.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
