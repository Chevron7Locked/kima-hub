"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { Radio } from "lucide-react";
import { TileCard } from "@/components/cards/TileCard";
import { HorizontalCarousel } from "@/components/ui/HorizontalCarousel";
import { cn } from "@/lib/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { cascadeStyle } from "@/lib/motion";
import { useLibraryGenresQuery, useLibraryDecadesQuery, useMoodStationsQuery } from "@/hooks/useQueries";
import { useFeatures } from "@/lib/features-context";
import {
    RadioStation,
    STATIC_STATIONS,
    buildMoodStations,
    buildGenreStations,
    playableStations,
    buildDecadeStations,
    useRadioPlayer,
} from "../radioData";

export function LibraryRadioStations() {
    const { loadingStation, startRadio } = useRadioPlayer();
    const { data: genresData, isLoading: genresLoading } = useLibraryGenresQuery();
    const { data: decadesData, isLoading: decadesLoading } = useLibraryDecadesQuery();
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const { data: moodData, isLoading: moodLoading } = useMoodStationsQuery(!featuresLoading && vibeEmbeddings);

    // Until the feature check answers, which stations can play is unknown: the row waits rather than letting
    // Workout and the mood stations pop in among tiles already shown.
    const isLoading = genresLoading || decadesLoading || featuresLoading || moodLoading;
    const genres = useMemo(
        () => (genresData?.genres || []).filter((g) => g.count >= 15).slice(0, 6),
        [genresData],
    );
    const decades = useMemo(
        () => (decadesData?.decades || []).slice(0, 4),
        [decadesData],
    );

    const allStations = useMemo(() => {
        if (featuresLoading || moodLoading) return [];
        return [
            ...playableStations(STATIC_STATIONS, vibeEmbeddings),
            ...playableStations(buildMoodStations(moodData?.stations ?? []), vibeEmbeddings),
            ...buildGenreStations(genres),
            ...buildDecadeStations(decades),
        ];
    }, [genres, decades, vibeEmbeddings, featuresLoading, moodLoading, moodData]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [currentPage, setCurrentPage] = useState(0);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const stationPages = useMemo(() => {
        const pages: RadioStation[][] = [];
        for (let i = 0; i < allStations.length; i += 6) {
            pages.push(allStations.slice(i, i + 6));
        }
        return pages;
    }, [allStations]);

    const updatePage = useCallback(() => {
        const el = scrollRef.current;
        if (el) setCurrentPage(Math.round(el.scrollLeft / el.clientWidth));
    }, []);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        updatePage();
        el.addEventListener("scroll", updatePage);
        window.addEventListener("resize", updatePage);
        return () => {
            el.removeEventListener("scroll", updatePage);
            window.removeEventListener("resize", updatePage);
        };
    }, [stationPages, isMobileOrTablet, updatePage]);

    const renderCard = (station: RadioStation, compact: boolean, globalIdx: number, delayIdx = globalIdx) => (
        <TileCard
            key={station.id}
            title={station.name}
            subtitle={station.description}
            wrapSubtitle={!compact}
            eyebrow={
                <span className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <Radio className="w-3 h-3" />
                    Radio
                </span>
            }
            tint={station.color}
            hoverBorder={station.hoverBorder}
            accent={station.accentGradient}
            onClick={() => startRadio(station)}
            playable
            busy={loadingStation === station.id}
            disabled={loadingStation !== null}
            index={delayIdx}
            className={compact ? "flex-shrink-0 snap-start w-[180px] h-[80px]" : "w-full aspect-[5/3]"}
        />
    );

    if (!isMobileOrTablet) {
        return (
            <HorizontalCarousel style={cascadeStyle(allStations.length)}>
                {allStations.map((station, i) => renderCard(station, true, i))}
                {isLoading &&
                    Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="flex-shrink-0 w-[180px] h-[80px] rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
                    ))}
            </HorizontalCarousel>
        );
    }

    // Mobile: 2x3 grid pages
    return (
        <div className="relative">
            <div
                ref={scrollRef}
                className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-3"
            >
                {stationPages.map((page, pageIndex) => (
                    <div
                        key={pageIndex}
                        className="flex-shrink-0 snap-start w-full grid grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2 gap-2"
                        style={cascadeStyle(page.length)}
                    >
                        {page.map((station, i) => renderCard(station, false, pageIndex * 6 + i, i))}
                        {page.length < 6 &&
                            Array.from({ length: 6 - page.length }).map((_, i) => (
                                <div key={`empty-${i}`} className="aspect-[5/3]" />
                            ))}
                    </div>
                ))}
                {isLoading && (
                    <div className="flex-shrink-0 snap-start w-full grid grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2 gap-2">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="aspect-[5/3] rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
                        ))}
                    </div>
                )}
            </div>

            {stationPages.length > 1 && (
                <div className="flex justify-center mt-1">
                    {stationPages.map((_, index) => (
                        <button
                            key={index}
                            onClick={() => {
                                const el = scrollRef.current;
                                if (el) el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" });
                            }}
                            className="group/dot flex items-center justify-center"
                            aria-label={`Go to page ${index + 1}`}
                            aria-current={index === currentPage ? "true" : undefined}
                        >
                            <span
                                className={cn(
                                    "w-1.5 h-1.5 rounded-full transition-colors",
                                    index === currentPage ? "bg-white" : "bg-white/30 group-hover/dot:bg-white/50",
                                )}
                            />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
