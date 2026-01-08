"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Library, BookOpen, Mic, ListMusic } from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

const navigationItems = [
    { 
        name: "Library", 
        href: "/library", 
        icon: Library,
        matchPattern: "/library"
    },
    { 
        name: "Audiobooks", 
        href: "/audiobooks", 
        icon: BookOpen,
        matchPattern: "/audiobooks"
    },
    { 
        name: "Podcasts", 
        href: "/podcasts", 
        icon: Mic,
        matchPattern: "/podcasts"
    },
    { 
        name: "Playlists", 
        href: "/playlists", 
        icon: ListMusic,
        matchPattern: "/playlist" // Matches both /playlists and /playlist/[id]
    },
];

export function BottomNavigation() {
    const pathname = usePathname();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Only render on mobile/tablet
    if (!isMobileOrTablet) return null;

    return (
        <nav
            className="fixed bottom-0 left-0 right-0 z-40 bg-black border-t border-white/10"
            role="navigation"
            aria-label="Main navigation"
            style={{
                paddingBottom: 'env(safe-area-inset-bottom, 0px)'
            }}
        >
            <div className="flex items-center justify-around h-14">
                {navigationItems.map((item) => {
                    const isActive = pathname.startsWith(item.matchPattern);
                    const Icon = item.icon;

                    return (
                        <Link
                            key={item.name}
                            href={item.href}
                            className={cn(
                                "flex flex-col items-center justify-center flex-1 h-full py-2 transition-colors",
                                isActive
                                    ? "text-white"
                                    : "text-gray-500 active:text-gray-300"
                            )}
                            aria-label={item.name}
                            aria-current={isActive ? "page" : undefined}
                        >
                            <Icon 
                                className={cn(
                                    "w-5 h-5 mb-1",
                                    isActive && "text-white"
                                )} 
                                strokeWidth={isActive ? 2.5 : 2}
                            />
                            <span 
                                className={cn(
                                    "text-[10px] tracking-wide",
                                    isActive ? "font-semibold" : "font-medium"
                                )}
                            >
                                {item.name}
                            </span>
                        </Link>
                    );
                })}
            </div>
        </nav>
    );
}
