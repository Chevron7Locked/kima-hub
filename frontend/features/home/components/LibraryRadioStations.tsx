"use client";

import { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { TileCard } from "@/components/cards/TileCard";
import { StationCard } from "./StationCard";
import { HorizontalCarousel } from "@/components/ui/HorizontalCarousel";
import { cn } from "@/lib/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { cascadeStyle } from "@/lib/motion";
import { useLibraryGenresQuery, useLibraryDecadesQuery, useMoodStationsQuery, useStationCovers } from "@/hooks/useQueries";
import { useFeatures } from "@/lib/features-context";
import {
    DEFAULT_STYLE,
    RadioStation,
    STATIC_STATIONS,
    buildMoodStations,
    buildGenreStations,
    playableStations,
    buildDecadeStations,
    useRadioPlayer,
} from "../radioData";

/** A tile in the row: a station, a mood station still loading, or the mood list's retry. */
type RowItem = { kind: "station"; station: RadioStation } | { kind: "placeholder"; key: string } | { kind: "retry" };

/** Tiles the mood stations hold while their list loads. */
const MOOD_PLACEHOLDERS = 4;

export function LibraryRadioStations() {
    const { loadingStation, startRadio } = useRadioPlayer();
    const { data: genresData, isLoading: genresLoading } = useLibraryGenresQuery();
    const { data: decadesData, isLoading: decadesLoading } = useLibraryDecadesQuery();
    const { vibeEmbeddings, loading: featuresLoading } = useFeatures();
    const {
        data: moodData,
        isLoading: moodLoading,
        isError: moodError,
        isFetching: moodFetching,
        refetch: refetchMoods,
    } = useMoodStationsQuery(!featuresLoading && vibeEmbeddings);

    // Until the feature check answers, which stations can play is unknown: the row waits rather than letting
    // Workout pop in among tiles already shown. The mood stations' own list does not hold the row up.
    const isLoading = genresLoading || decadesLoading || featuresLoading;
    const genres = useMemo(
        () => (genresData?.genres || []).filter((g) => g.count >= 15).slice(0, 6),
        [genresData],
    );
    const decades = useMemo(
        () => (decadesData?.decades || []).slice(0, 4),
        [decadesData],
    );

    const allItems = useMemo((): RowItem[] => {
        if (featuresLoading) return [];
        const station = (s: RadioStation): RowItem => ({ kind: "station", station: s });
        // The mood stations hold their place while their list loads, and a list that failed says so there.
        const moods: RowItem[] = !vibeEmbeddings
            ? []
            : moodLoading
              ? Array.from({ length: MOOD_PLACEHOLDERS }, (_, i) => ({ kind: "placeholder" as const, key: `mood-wait-${i}` }))
              : moodError
                ? [{ kind: "retry" }]
                : buildMoodStations(moodData?.stations ?? []).map(station);
        return [
            ...playableStations(STATIC_STATIONS, vibeEmbeddings).map(station),
            ...moods,
            ...buildGenreStations(genres).map(station),
            ...buildDecadeStations(decades).map(station),
        ];
    }, [genres, decades, vibeEmbeddings, featuresLoading, moodLoading, moodError, moodData]);

    // One request for every tile's cover, once the row's stations are all known (mood stations not still loading).
    const stations = useMemo(
        () => allItems.flatMap((item) => (item.kind === "station" ? [item.station] : [])),
        [allItems],
    );
    const { data: covers } = useStationCovers(stations, !isLoading && !(vibeEmbeddings && moodLoading));

    const scrollRef = useRef<HTMLDivElement>(null);
    const [currentPage, setCurrentPage] = useState(0);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const stationPages = useMemo(() => {
        const pages: RowItem[][] = [];
        for (let i = 0; i < allItems.length; i += 6) {
            pages.push(allItems.slice(i, i + 6));
        }
        return pages;
    }, [allItems]);

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

    const tileSize = (compact: boolean) => (compact ? "flex-shrink-0 snap-start w-(--card-w) h-30" : "w-full h-30");

    const renderCard = (station: RadioStation, compact: boolean, delayIdx: number) => (
        <StationCard
            key={station.id}
            station={station}
            cover={covers?.get(station.id)}
            onStart={startRadio}
            busy={loadingStation === station.id}
            disabled={loadingStation !== null}
            index={delayIdx}
            className={tileSize(compact)}
        />
    );

    const renderItem = (item: RowItem, compact: boolean, delayIdx: number) => {
        if (item.kind === "station") return renderCard(item.station, compact, delayIdx);
        if (item.kind === "placeholder") {
            return (
                <div
                    key={item.key}
                    className={cn(tileSize(compact), "rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse")}
                />
            );
        }
        return (
            <TileCard
                key="mood-retry"
                title="Mood stations"
                subtitle="Didn't load. Try again"
                tint={DEFAULT_STYLE.color}
                hoverBorder={DEFAULT_STYLE.hoverBorder}
                accent={DEFAULT_STYLE.accentGradient}
                onClick={() => void refetchMoods()}
                busy={moodFetching}
                index={delayIdx}
                className={tileSize(compact)}
            />
        );
    };

    if (!isMobileOrTablet) {
        return (
            <HorizontalCarousel style={cascadeStyle(allItems.length)}>
                {allItems.map((item, i) => renderItem(item, true, i))}
                {isLoading &&
                    Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="flex-shrink-0 w-(--card-w) h-30 rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
                    ))}
            </HorizontalCarousel>
        );
    }

    // Mobile: 2x3 grid pages
    return (
        <div className="relative">
            <div
                ref={scrollRef}
                className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-(--card-gap)"
            >
                {stationPages.map((page, pageIndex) => (
                    <div
                        key={pageIndex}
                        className="flex-shrink-0 snap-start w-full grid grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2 gap-(--card-gap)"
                        style={cascadeStyle(page.length)}
                    >
                        {page.map((item, i) => renderItem(item, false, i))}
                        {page.length < 6 &&
                            Array.from({ length: 6 - page.length }).map((_, i) => (
                                <div key={`empty-${i}`} className="h-30" />
                            ))}
                    </div>
                ))}
                {isLoading && (
                    <div className="flex-shrink-0 snap-start w-full grid grid-cols-2 grid-rows-3 sm:grid-cols-3 sm:grid-rows-2 gap-(--card-gap)">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="h-30 rounded-lg bg-[var(--bg-primary)] border border-white/10 animate-pulse" />
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
