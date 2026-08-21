"use client";

import { useRef, useState, useEffect, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

interface HorizontalCarouselProps {
    children: ReactNode;
    className?: string;
    itemClassName?: string;
    showArrows?: boolean;
    gap?: "sm" | "md" | "lg";
}

export function HorizontalCarousel({
    children,
    className,
    itemClassName: _itemClassName,
    showArrows = true,
    gap = "md",
}: HorizontalCarouselProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const gapClass = {
        sm: "gap-2",
        md: "gap-3",
        lg: "gap-4",
    }[gap];

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
            {showArrows && !isMobileOrTablet && canScrollLeft && (
                <button
                    onClick={() => scroll("left")}
                    className={cn(
                        "absolute left-0 top-1/2 -translate-y-1/2 z-(--z-raised)",
                        "w-10 h-10 rounded-full bg-black/80 ",
                        "flex items-center justify-center",
                        "opacity-0 group-hover/carousel:opacity-100 transition-opacity",
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
                className={cn(
                    "flex overflow-x-auto scrollbar-hide scroll-smooth",
                    "snap-x snap-mandatory",
                    gapClass,
                    // Padding for edge items
                    "px-1"
                )}
            >
                {children}
            </div>

            {/* Right arrow */}
            {showArrows && !isMobileOrTablet && canScrollRight && (
                <button
                    onClick={() => scroll("right")}
                    className={cn(
                        "absolute right-0 top-1/2 -translate-y-1/2 z-(--z-raised)",
                        "w-10 h-10 rounded-full bg-black/80 ",
                        "flex items-center justify-center",
                        "opacity-0 group-hover/carousel:opacity-100 transition-opacity",
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

// Wrapper for carousel items with consistent sizing
interface CarouselItemProps {
    children: ReactNode;
    className?: string;
}

export function CarouselItem({ children, className }: CarouselItemProps) {
    return (
        <div
            className={cn(
                "flex-shrink-0 snap-start",
                // Responsive widths - smaller items that fit more on screen
                "w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px]",
                className
            )}
        >
            {children}
        </div>
    );
}
