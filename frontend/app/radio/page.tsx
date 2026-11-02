"use client";

import { useRadioRow } from "@/hooks/useQueries";
import { StationCard } from "@/features/home/components/StationCard";
import { RadioStation, useRadioPlayer } from "@/features/home/radioData";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/layout/PageHeader";
import { useSoundRebuild, describeSoundRebuild } from "@/hooks/useSoundRebuild";

function SectionSkeleton() {
    return (
        <div className="grid-media">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-30 rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
            ))}
        </div>
    );
}

interface StationGridProps {
    stations: RadioStation[];
    covers?: Map<string, string | null>;
    loadingStation: string | null;
    onStart: (station: RadioStation) => void;
}

function StationGrid({ stations, covers, loadingStation, onStart }: StationGridProps) {
    return (
        <div className="grid-media">
            {stations.map((station, i) => (
                <StationCard
                    key={station.id}
                    station={station}
                    cover={covers?.get(station.id)}
                    onStart={onStart}
                    busy={loadingStation === station.id}
                    disabled={loadingStation !== null}
                    index={i}
                    className="w-full h-30"
                />
            ))}
        </div>
    );
}

interface StationSectionProps extends Omit<StationGridProps, "stations"> {
    title: string;
    unit: string;
    stations: RadioStation[];
    isLoading: boolean;
    /** A line under the heading, for a section whose stations are still filling in. */
    note?: string;
}

function StationSection({ title, unit, stations, isLoading, note, ...grid }: StationSectionProps) {
    if (!isLoading && stations.length === 0) return null;

    return (
        <section>
            <SectionHeader type="track" title={title} count={!isLoading ? `${stations.length} ${unit}` : undefined} />
            {note && <p className="-mt-1 mb-3 text-xs text-[var(--text-muted)]">{note}</p>}
            {isLoading ? <SectionSkeleton /> : <StationGrid stations={stations} {...grid} />}
        </section>
    );
}

export default function RadioPage() {
    const { loadingStation, startRadio } = useRadioPlayer();
    const rebuild = useSoundRebuild();
    // One reply names every station on the page and carries its cover, so the tiles draw once, covers in place.
    const { data: row, isLoading, isError, isFetching, refetch } = useRadioRow("all");
    const total = row ? row.quick.length + row.moods.length + row.genres.length + row.decades.length : 0;
    const grid = { covers: row?.covers, loadingStation, onStart: startRadio };

    return (
        <div className="min-h-screen">
            <div className="relative">
                <PageHeader
                    title="Radio"
                    description={row ? `${total} stations, each an endless shuffle from your own music` : "Endless shuffles from your own music"}
                />

                <div className="relative page-shell page-end pt-2 animate-rise">
                    <div className="section-stack">
                        {isError && !row ? (
                            <div className="flex items-center gap-3 py-4">
                                <p className="text-sm text-[var(--text-secondary)]">Could not load the stations.</p>
                                <Button onClick={() => void refetch()} disabled={isFetching} aria-label="Retry loading the stations">
                                    Retry
                                </Button>
                            </div>
                        ) : (
                            <>
                                <section>
                                    <SectionHeader title="Quick Start" />
                                    {isLoading ? <SectionSkeleton /> : <StationGrid stations={row?.quick ?? []} {...grid} />}
                                </section>

                                <StationSection
                                    title="By Mood"
                                    unit="stations"
                                    stations={row?.moods ?? []}
                                    note={
                                        rebuild && rebuild.step !== "map"
                                            ? `Mood stations fill in as your sound features are built. ${describeSoundRebuild(rebuild)}`
                                            : undefined
                                    }
                                    isLoading={isLoading}
                                    {...grid}
                                />

                                <StationSection title="By Genre" unit="genres" stations={row?.genres ?? []} isLoading={isLoading} {...grid} />

                                <StationSection title="By Decade" unit="decades" stations={row?.decades ?? []} isLoading={isLoading} {...grid} />
                            </>
                        )}

                        <p className="t-meta">
                            Genre and decade stations appear once your library has enough tracks for them.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
