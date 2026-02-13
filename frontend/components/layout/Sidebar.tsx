"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { Plus, Settings, RefreshCw } from "lucide-react";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useQuery } from "@tanstack/react-query";
import { useAudioState } from "@/lib/audio-state-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useToast } from "@/lib/toast-context";
import Image from "next/image";
import { MobileSidebar } from "./MobileSidebar";

const navigation = [
    { name: "Library", href: "/library" },
    // { name: "Vibe", href: "/vibe" }, // Hidden until UI refinement complete
    { name: "Radio", href: "/radio" },
    { name: "Discovery", href: "/discover" },
    { name: "Audiobooks", href: "/audiobooks" },
    { name: "Podcasts", href: "/podcasts" },
    { name: "Browse", href: "/browse/playlists" },
] as const;

interface Playlist {
    id: string;
    name: string;
    trackCount: number;
    isHidden?: boolean;
    isOwner?: boolean;
    user?: { username: string };
}

export function Sidebar() {
    const pathname = usePathname();
    const { isAuthenticated } = useAuth();
    const { toast } = useToast();
    const { currentTrack, currentAudiobook, currentPodcast, playbackType } =
        useAudioState();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const { data: playlists = [], isLoading: isLoadingPlaylists } = useQuery<
        Playlist[]
    >({
        queryKey: ["playlists"],
        queryFn: () => api.getPlaylists(),
        enabled: isAuthenticated,
    });

    // Handle library sync - no toast, notification bar handles feedback
    const handleSync = async () => {
        if (isSyncing) return;

        try {
            setIsSyncing(true);
            await api.scanLibrary();
        } catch (error) {
            console.error("Failed to trigger library scan:", error);
            toast.error("Failed to start scan. Please try again.");
        } finally {
            syncTimeoutRef.current = setTimeout(() => setIsSyncing(false), 2000);
        }
    };

    useEffect(() => {
        return () => {
            if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
        };
    }, []);

    // Close mobile menu when route changes
    useEffect(() => {
        setIsMobileMenuOpen(false);
    }, [pathname]);

    // Close mobile menu on escape key
    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsMobileMenuOpen(false);
        };

        if (isMobileMenuOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "unset";
        };
    }, [isMobileMenuOpen]);

    // Listen for toggle event from TopBar
    useEffect(() => {
        const handleToggle = () => setIsMobileMenuOpen(true);
        window.addEventListener("toggle-mobile-menu", handleToggle);
        return () =>
            window.removeEventListener("toggle-mobile-menu", handleToggle);
    }, []);

    // Don't show sidebar on login/register pages
    // (Check after all hooks to comply with Rules of Hooks)
    if (pathname === "/login" || pathname === "/register") {
        return null;
    }

    // Render sidebar content inline to prevent component recreation
    const sidebarContent = (
        <>
            {/* Mobile Only - Logo and App Info */}
            {isMobileOrTablet && (
                <div className="px-6 pt-8 pb-6 border-b border-white/[0.08]">
                    {/* Logo and Title */}
                    <div className="flex items-center gap-4 mb-5">
                        <Image
                            src="/assets/images/LIDIFY.webp"
                            alt="Lidify"
                            width={48}
                            height={48}
                            className="flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                            <h2 className="text-2xl font-black text-white tracking-tight">
                                Lidify
                            </h2>
                            {(
                                !currentTrack &&
                                !currentAudiobook &&
                                !currentPodcast
                            ) ?
                                <p className="text-sm text-gray-400 font-medium">
                                    Stream Your Way
                                </p>
                            :   <div className="text-xs text-gray-400 truncate">
                                    <span className="text-gray-500">
                                        Listening to:{" "}
                                    </span>
                                    <span className="text-white font-medium">
                                        {(
                                            playbackType === "track" &&
                                            currentTrack
                                        ) ?
                                            `${currentTrack.artist?.name} - ${currentTrack.album?.title}`
                                        : (
                                            playbackType === "audiobook" &&
                                            currentAudiobook
                                        ) ?
                                            currentAudiobook.title
                                        : (
                                            playbackType === "podcast" &&
                                            currentPodcast
                                        ) ?
                                            currentPodcast.podcastTitle
                                        :   ""}
                                    </span>
                                </div>
                            }
                        </div>
                    </div>

                    {/* Quick Actions - Settings and Sync */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleSync}
                            disabled={isSyncing}
                            className={cn(
                                "w-10 h-10 flex items-center justify-center rounded-full transition-all duration-300",
                                isSyncing ?
                                    "bg-[#1DB954] text-black"
                                :   "bg-white/10 text-white hover:bg-white/15 active:scale-95",
                            )}
                            aria-label={
                                isSyncing ? "Syncing library" : "Sync library"
                            }
                            title={isSyncing ? "Syncing..." : "Sync Library"}
                        >
                            <RefreshCw
                                className={cn(
                                    "w-4 h-4 transition-transform",
                                    isSyncing && "animate-spin",
                                )}
                            />
                        </button>

                        <Link
                            href="/settings"
                            className={cn(
                                "w-10 h-10 flex items-center justify-center rounded-full transition-all",
                                pathname === "/settings" ?
                                    "bg-white text-black"
                                :   "bg-white/10 text-gray-400 hover:text-white hover:bg-white/15 active:scale-95",
                            )}
                            aria-label="Settings"
                            title="Settings"
                        >
                            <Settings className="w-4 h-4" />
                        </Link>
                    </div>
                </div>
            )}

            {/* Navigation - Command Index */}
            <nav
                className={cn("pt-6", isMobileOrTablet ? "px-4" : "px-3")}
                role="navigation"
                aria-label="Main navigation"
            >
                <div className="mb-3 flex items-center gap-2 px-2">
                    <div className="w-1.5 h-1.5 bg-[#22c55e] rounded-full" />
                    <span className="text-[10px] font-mono font-black text-gray-600 uppercase tracking-wider">
                        Navigation Index
                    </span>
                </div>
                <div className="space-y-0.5">
                    {navigation.map((item, index) => {
                        const isActive = pathname === item.href;

                        return (
                            <Link
                                key={item.name}
                                href={item.href}
                                prefetch={false}
                                aria-current={isActive ? "page" : undefined}
                                className={cn(
                                    "flex items-center gap-3 py-2.5 px-2 border-l-2 transition-all duration-200 group relative",
                                    isActive ?
                                        "bg-[#0a0a0a] border-[#eab308] text-white"
                                    :   "border-transparent text-gray-500 hover:text-white hover:bg-white/5 hover:border-white/20",
                                )}
                            >
                                {/* Command index number */}
                                <span
                                    className={cn(
                                        "w-6 text-xs font-mono font-bold text-center shrink-0",
                                        isActive ? "text-[#eab308]" : (
                                            "text-gray-700 group-hover:text-gray-500"
                                        ),
                                    )}
                                >
                                    {String(index + 1).padStart(2, "0")}
                                </span>

                                {/* Vertical separator */}
                                <div
                                    className={cn(
                                        "w-px h-4 shrink-0",
                                        isActive ? "bg-[#eab308]/30" : (
                                            "bg-white/10 group-hover:bg-white/20"
                                        ),
                                    )}
                                />

                                {/* Label */}
                                <span
                                    className={cn(
                                        "font-black text-sm uppercase tracking-tight",
                                        isActive ? "text-white" : (
                                            "group-hover:text-white"
                                        ),
                                    )}
                                >
                                    {item.name}
                                </span>
                            </Link>
                        );
                    })}
                </div>

                {/* Horizontal rule separator */}
                <div className="mt-4 mb-4 border-t-2 border-white/10" />
            </nav>

            {/* Playlists Section - Data Stack */}
            <div className="flex-1 overflow-hidden flex flex-col">
                <div
                    className={cn(
                        "mb-3 flex items-center justify-between",
                        isMobileOrTablet ? "px-4" : "px-3",
                    )}
                >
                    <div className="flex items-center gap-2 px-2">
                        <div className="w-1.5 h-1.5 bg-[#a855f7] rounded-full" />
                        <Link
                            href="/playlists"
                            prefetch={false}
                            className="group/link"
                        >
                            <span className="text-[10px] font-mono font-black text-gray-600 uppercase tracking-wider group-hover/link:text-[#a855f7] transition-colors">
                                Playlist Stack
                            </span>
                        </Link>
                    </div>
                    <Link
                        href="/playlists"
                        prefetch={false}
                        className="w-6 h-6 flex items-center justify-center bg-[#0a0a0a] border-2 border-white/10 text-gray-500 hover:text-[#a855f7] hover:border-[#a855f7]/50 hover:bg-[#a855f7]/5 transition-all"
                        aria-label="Create playlist"
                        title="Create Playlist"
                    >
                        <Plus className="w-3.5 h-3.5" />
                    </Link>
                </div>
                <div
                    className={cn(
                        "flex-1 overflow-y-auto space-y-0.5 scrollbar-thin scrollbar-thumb-[#1c1c1c] scrollbar-track-transparent",
                        isMobileOrTablet ? "px-4" : "px-3",
                    )}
                >
                    {isLoadingPlaylists ?
                        <>
                            {[1, 2, 3, 4, 5].map((i) => (
                                <div
                                    key={i}
                                    className="px-2 py-2 bg-[#0a0a0a] border-l-2 border-transparent"
                                >
                                    <div className="h-3.5 bg-white/5 rounded w-3/4 mb-1.5"></div>
                                    <div className="h-2.5 bg-white/5 rounded w-1/2"></div>
                                </div>
                            ))}
                        </>
                    : playlists.filter((p) => !p.isHidden).length > 0 ?
                        playlists
                            .filter((p) => !p.isHidden)
                            .map((playlist, index) => {
                                const isActive =
                                    pathname === `/playlist/${playlist.id}`;
                                const isShared = playlist.isOwner === false;
                                return (
                                    <Link
                                        key={playlist.id}
                                        href={`/playlist/${playlist.id}`}
                                        prefetch={false}
                                        className={cn(
                                            "flex items-center gap-3 py-2 px-2 border-l-2 transition-all group",
                                            isActive ?
                                                "bg-[#0a0a0a] border-[#a855f7] text-white"
                                            :   "border-transparent text-gray-600 hover:text-white hover:bg-white/5 hover:border-white/20",
                                        )}
                                    >
                                        {/* Stack index */}
                                        <span
                                            className={cn(
                                                "w-5 text-[10px] font-mono font-bold text-center shrink-0",
                                                isActive ? "text-[#a855f7]" : (
                                                    "text-gray-700 group-hover:text-gray-500"
                                                ),
                                            )}
                                        >
                                            {String(index + 1).padStart(2, "0")}
                                        </span>

                                        {/* Content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <div
                                                    className={cn(
                                                        "text-xs font-bold uppercase tracking-tight truncate",
                                                        isActive ? "text-white"
                                                        :   "group-hover:text-white",
                                                    )}
                                                >
                                                    {playlist.name}
                                                </div>
                                                {isShared && (
                                                    <span
                                                        className="shrink-0 w-1 h-1 rounded-full bg-[#a855f7]"
                                                        title={`Shared by ${
                                                            playlist.user
                                                                ?.username ||
                                                            "someone"
                                                        }`}
                                                    />
                                                )}
                                            </div>
                                            <div
                                                className={cn(
                                                    "text-[10px] font-mono truncate mt-0.5",
                                                    isActive ? "text-gray-600"
                                                    :   "text-gray-700 group-hover:text-gray-500",
                                                )}
                                            >
                                                {playlist.trackCount} TRK
                                                {isShared &&
                                                    ` • ${playlist.user?.username || "SHARED"}`}
                                            </div>
                                        </div>
                                    </Link>
                                );
                            })
                    :   <div className="px-2 py-6 border-l-2 border-transparent">
                            <div className="text-xs font-mono text-gray-700 mb-1 uppercase">
                                Empty Stack
                            </div>
                            <div className="text-[10px] font-mono text-gray-800">
                                Create first entry
                            </div>
                        </div>
                    }
                </div>
            </div>
        </>
    );

    return (
        <>
            {/* Mobile Sidebar */}
            {isMobileOrTablet && (
                <MobileSidebar
                    isOpen={isMobileMenuOpen}
                    onClose={() => setIsMobileMenuOpen(false)}
                />
            )}

            {/* Desktop Sidebar */}
            {!isMobileOrTablet && (
                <aside className="w-72 bg-[#0a0a0a] flex flex-col overflow-hidden relative z-10">
                    {sidebarContent}
                </aside>
            )}
        </>
    );
}
