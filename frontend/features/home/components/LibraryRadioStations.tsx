"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Radio, Play, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import {
    RadioStation,
    GenreCount,
    DecadeCount,
    STATIC_STATIONS,
    buildGenreStations,
    buildDecadeStations,
    useRadioPlayer,
} from "../radioData";

export function LibraryRadioStations() {
    const { loadingStation, startRadio } = useRadioPlayer();
    const [genres, setGenres] = useState<GenreCount[]>([]);
    const [decades, setDecades] = useState<DecadeCount[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [genresRes, decadesRes] = await Promise.all([
                    api.get<{ genres: GenreCount[] }>("/library/genres"),
                    api.get<{ decades: DecadeCount[] }>("/library/decades"),
                ]);
                setGenres((genresRes.genres || []).filter((g) => g.count >= 15).slice(0, 6));
                setDecades((decadesRes.decades || []).slice(0, 4));
            } catch (error) {
                console.error("Failed to fetch radio data:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchData();
    }, []);

    const allStations = useMemo(() => {
        return [
            ...STATIC_STATIONS,
            ...buildGenreStations(genres),
            ...buildDecadeStations(decades),
        ];
    }, [genres, decades]);

    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
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

    const checkScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setCanScrollLeft(el.scrollLeft > 0);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
        if (isMobileOrTablet) {
            const pageWidth = el.clientWidth;
            setCurrentPage(Math.round(el.scrollLeft / pageWidth));
        }
    }, [isMobileOrTablet]);

    useEffect(() => {
        checkScroll();
        const el = scrollRef.current;
        if (el) {
            el.addEventListener("scroll", checkScroll);
            window.addEventListener("resize", checkScroll);
        }
        return () => {
            if (el) el.removeEventListener("scroll", checkScroll);
            window.removeEventListener("resize", checkScroll);
        };
    }, [stationPages, isMobileOrTablet, checkScroll]);

    const scroll = (direction: "left" | "right") => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollBy({
            left: direction === "left" ? -(el.clientWidth * 0.8) : el.clientWidth * 0.8,
            behavior: "smooth",
        });
    };

    const renderCard = (station: RadioStation, compact: boolean) => (
        <button
            key={station.id}
            onClick={() => startRadio(station)}
            disabled={loadingStation !== null}
            className={cn(
                "relative group overflow-hidden",
                "bg-[#0a0a0a] border border-white/10 rounded-lg",
                station.hoverBorder,
                "transition-all duration-300",
                "hover:shadow-lg",
                station.hoverShadow,
                "disabled:opacity-50 disabled:cursor-not-allowed",
                compact
                    ? "flex-shrink-0 snap-start w-[180px] h-[80px]"
                    : "w-full aspect-[5/3]"
            )}
        >
            {/* Subtle gradient tint */}
            <div className={cn("absolute inset-0 bg-gradient-to-br", station.color)} />

            {/* Content */}
            <div className="absolute inset-0 p-3 flex flex-col justify-between">
                <div className="flex items-center gap-1.5">
                    <Radio className="w-3 h-3 text-white/50" />
                    <span className="text-[8px] font-mono text-white/50 uppercase tracking-wider">
                        Radio
                    </span>
                </div>
                <div>
                    <h3 className="text-sm font-black text-white truncate tracking-tight leading-tight">
                        {station.name}
                    </h3>
                    <p className="text-[10px] font-mono text-gray-500 uppercase tracking-wider truncate">
                        {station.description}
                    </p>
                </div>
            </div>

            {/* Bottom accent bar on hover */}
            <div className={cn(
                "absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r",
                station.accentGradient,
                "transform scale-x-0 group-hover:scale-x-100 transition-transform duration-150"
            )} />

            {/* Loading overlay */}
            {loadingStation === station.id && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
                    <Loader2 className="w-5 h-5 text-white animate-spin" />
                </div>
            )}

            {/* Play overlay on hover */}
            {loadingStation !== station.id && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center shadow-lg">
                        <Play className="w-4 h-4 text-black ml-0.5" fill="currentColor" />
                    </div>
                </div>
            )}
        </button>
    );

    // Desktop: horizontal scroll
    if (!isMobileOrTablet) {
        return (
            <div className="relative group/carousel">
                {canScrollLeft && (
                    <button
                        onClick={() => scroll("left")}
                        className="absolute left-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-lg bg-black/80 flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black border border-white/10 shadow-lg -translate-x-1/2"
                        aria-label="Scroll left"
                    >
                        <ChevronLeft className="w-5 h-5 text-white" />
                    </button>
                )}

                <div
                    ref={scrollRef}
                    className="flex overflow-x-auto scrollbar-hide scroll-smooth snap-x snap-mandatory gap-3 px-1"
                >
                    {allStations.map((station) => renderCard(station, true))}
                    {isLoading &&
                        Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="flex-shrink-0 w-[180px] h-[80px] rounded-lg bg-[#0a0a0a] border border-white/10 animate-pulse" />
                        ))}
                </div>

                {canScrollRight && (
                    <button
                        onClick={() => scroll("right")}
                        className="absolute right-0 top-1/2 -translate-y-1/2 z-10 w-9 h-9 rounded-lg bg-black/80 flex items-center justify-center opacity-0 group-hover/carousel:opacity-100 transition-opacity hover:bg-black border border-white/10 shadow-lg translate-x-1/2"
                        aria-label="Scroll right"
                    >
                        <ChevronRight className="w-5 h-5 text-white" />
                    </button>
                )}
            </div>
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
                        className="flex-shrink-0 snap-start w-full grid grid-cols-3 grid-rows-2 gap-2"
                    >
                        {page.map((station) => renderCard(station, false))}
                        {page.length < 6 &&
                            Array.from({ length: 6 - page.length }).map((_, i) => (
                                <div key={`empty-${i}`} className="aspect-[5/3]" />
                            ))}
                    </div>
                ))}
                {isLoading && (
                    <div className="flex-shrink-0 snap-start w-full grid grid-cols-3 grid-rows-2 gap-2">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="aspect-[5/3] rounded-lg bg-[#0a0a0a] border border-white/10 animate-pulse" />
                        ))}
                    </div>
                )}
            </div>

            {stationPages.length > 1 && (
                <div className="flex justify-center gap-1.5 mt-3">
                    {stationPages.map((_, index) => (
                        <button
                            key={index}
                            onClick={() => {
                                const el = scrollRef.current;
                                if (el) el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" });
                            }}
                            className={cn(
                                "w-1.5 h-1.5 rounded-full transition-colors",
                                index === currentPage ? "bg-white" : "bg-white/30 hover:bg-white/50"
                            )}
                            aria-label={`Go to page ${index + 1}`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
