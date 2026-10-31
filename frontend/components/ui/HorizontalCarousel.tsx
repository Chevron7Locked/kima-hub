"use client";

import { useRef, useState, useEffect, type CSSProperties, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

interface HorizontalCarouselProps {
    children: ReactNode;
    className?: string;
    style?: CSSProperties;
}

export function HorizontalCarousel({
    children,
    className,
    style,
}: HorizontalCarouselProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const checkScroll = () => {
        const el = scrollRef.current;
        if (!el) return;

        setCanScrollLeft(el.scrollLeft > 0);
        setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
    };

    useEffect(() => {
        checkScroll();
        const el = scrollRef.current;
        if (el) {
            el.addEventListener("scroll", checkScroll);
            window.addEventListener("resize", checkScroll);
        }
        return () => {
            if (el) {
                el.removeEventListener("scroll", checkScroll);
            }
            window.removeEventListener("resize", checkScroll);
        };
    }, [children]);

    const scroll = (direction: "left" | "right") => {
        const el = scrollRef.current;
        if (!el) return;

        // Scroll by approximately 3 items worth
        const scrollAmount = el.clientWidth * 0.8;
        el.scrollBy({
            left: direction === "left" ? -scrollAmount : scrollAmount,
            behavior: "smooth",
        });
    };

    return (
        <div className={cn("relative group/carousel", className)}>
            {/* Left arrow */}
            {!isMobileOrTablet && canScrollLeft && (
                <button
                    onClick={() => scroll("left")}
                    className={cn(
                        "absolute left-0 top-1/2 -translate-y-1/2 z-(--z-raised)",
                        "w-10 h-10 rounded-full bg-black/80 ",
                        "flex items-center justify-center",
                        "opacity-0 group-hover/carousel:opacity-100 focus-visible:opacity-100 transition-opacity touch-reveal",
                        "hover:bg-black hover:scale-105 transition-all",
                        "border border-white/10",
                        "-translate-x-1/2"
                    )}
                    aria-label="Scroll left"
                >
                    <ChevronLeft className="w-5 h-5 text-white" />
                </button>
            )}

            {/* Scrollable container */}
            <div
                ref={scrollRef}
                style={style}
                className={cn(
                    "flex overflow-x-auto scrollbar-hide scroll-smooth",
                    "snap-x snap-mandatory",
                    // The padding leaves room for a card's focus ring and the negative margin keeps the first card on
                    // the page edge; the scroll padding stops snapping from scrolling that padding out of view.
                    "gap-(--card-gap) px-1 -mx-1 scroll-px-1"
                )}
            >
                {children}
            </div>

            {/* Right arrow */}
            {!isMobileOrTablet && canScrollRight && (
                <button
                    onClick={() => scroll("right")}
                    className={cn(
                        "absolute right-0 top-1/2 -translate-y-1/2 z-(--z-raised)",
                        "w-10 h-10 rounded-full bg-black/80 ",
                        "flex items-center justify-center",
                        "opacity-0 group-hover/carousel:opacity-100 focus-visible:opacity-100 transition-opacity touch-reveal",
                        "hover:bg-black hover:scale-105 transition-all",
                        "border border-white/10",
                        "translate-x-1/2"
                    )}
                    aria-label="Scroll right"
                >
                    <ChevronRight className="w-5 h-5 text-white" />
                </button>
            )}

            {/* Fade edges */}
            {canScrollLeft && !isMobileOrTablet && (
                <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-black/50 to-transparent pointer-events-none" />
            )}
            {canScrollRight && !isMobileOrTablet && (
                <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-black/50 to-transparent pointer-events-none" />
            )}
        </div>
    );
}

interface CarouselItemProps {
    children: ReactNode;
    className?: string;
}

export function CarouselItem({ children, className }: CarouselItemProps) {
    return (
        <div
            className={cn(
                "flex-shrink-0 snap-start",
                // The grid's card width from a tablet up; a phone shows a narrower card so the next one peeks in.
                "w-[140px] sm:w-[160px] md:w-(--card-w)",
                className
            )}
        >
            {children}
        </div>
    );
}
