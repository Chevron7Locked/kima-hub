"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { notify } from "@/lib/notify";
import { useFeatures } from "@/lib/features-context";
import { MobileSidebar } from "./MobileSidebar";
import { Button } from "@/components/ui/Button";

const allNavigation = [
    { name: "Collection", href: "/collection", feature: null },
    { name: "Queue", href: "/queue", feature: null },
    { name: "Radio", href: "/radio", feature: null },
    { name: "Discovery", href: "/discover", feature: null },
    { name: "Vibe", href: "/vibe", feature: null },
    { name: "Audiobooks", href: "/audiobooks", feature: "audiobookshelfEnabled" as const },
    { name: "Podcasts", href: "/podcasts", feature: null },
    { name: "Browse", href: "/browse/playlists", feature: null },
    { name: "Stats", href: "/stats", feature: null },
];

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
    const router = useRouter();
    const queryClient = useQueryClient();
    const { isAuthenticated } = useAuth();
    const { audiobookshelfEnabled } = useFeatures();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [showCreatePlaylist, setShowCreatePlaylist] = useState(false);
    const [newPlaylistName, setNewPlaylistName] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const createPopoverRef = useRef<HTMLDivElement>(null);

    const { data: playlists = [], isLoading: isLoadingPlaylists } = useQuery<
        Playlist[]
    >({
        queryKey: ["playlists"],
        queryFn: () => api.getPlaylists(),
        enabled: isAuthenticated,
    });

    useEffect(() => {
        setIsMobileMenuOpen(false);
    }, [pathname]);

    useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setIsMobileMenuOpen(false);
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

    useEffect(() => {
        const handleToggle = () => setIsMobileMenuOpen(true);
        window.addEventListener("toggle-mobile-menu", handleToggle);
        return () =>
            window.removeEventListener("toggle-mobile-menu", handleToggle);
    }, []);

    useEffect(() => {
        if (!showCreatePlaylist) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (
                createPopoverRef.current &&
                !createPopoverRef.current.contains(e.target as Node)
            ) {
                setShowCreatePlaylist(false);
                setNewPlaylistName("");
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [showCreatePlaylist]);

    const handleCreatePlaylist = async () => {
        const name = newPlaylistName.trim();
        if (!name || isCreating) return;
        try {
            setIsCreating(true);
            const result = await api.createPlaylist(name);
            await queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
            setShowCreatePlaylist(false);
            setNewPlaylistName("");
            router.push(`/playlist/${result.id}`);
        } catch {
            notify.error("Failed to create playlist");
        } finally {
            setIsCreating(false);
        }
    };

    if (pathname === "/login") {
        return null;
    }

    // Render sidebar content inline to prevent component recreation
    const sidebarContent = (
        <>

            <nav
                className="pt-6 px-3"
                role="navigation"
                aria-label="Main navigation"
            >
                <div className="mb-3 flex items-center gap-2 px-2 animate-rise">
                    <div className="w-1.5 h-1.5 bg-brand rounded-full" />
                    <span className="t-eyebrow">
                        Navigation Index
                    </span>
                </div>
                <div className="space-y-0.5">
                    {allNavigation.filter((item) =>
                        item.feature === null || (item.feature === "audiobookshelfEnabled" && audiobookshelfEnabled)
                    ).map((item, index) => {
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
                                        "bg-[var(--bg-primary)] border-brand text-white"
                                    :   "border-transparent text-[var(--text-muted)] hover:text-white hover:bg-white/5 hover:border-white/20",
                                )}
                            >
                                <span
                                    className={cn(
                                        "w-6 text-xs tabular-nums font-semibold text-center shrink-0 transition-colors duration-200",
                                        isActive ? "text-brand" : (
                                            "text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]"
                                        ),
                                    )}
                                >
                                    {String(index + 1).padStart(2, "0")}
                                </span>

                                <div
                                    className={cn(
                                        "w-px h-4 shrink-0",
                                        isActive ? "bg-brand/30" : (
                                            "bg-white/10 group-hover:bg-white/20"
                                        ),
                                    )}
                                />

                                <span
                                    className={cn(
                                        "font-bold text-sm tracking-tight",
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

                <div className="mt-4 mb-4 border-t-2 border-white/10" />
            </nav>

            {/* Playlists Section - Data Stack */}
            <div className="flex-1 overflow-hidden flex flex-col">
                <div
                    className="mb-3 flex items-center justify-between px-3"
                >
                    <div className="flex items-center gap-2 px-2 animate-rise">
                        <div className="w-1.5 h-1.5 bg-type-track rounded-full" />
                        <Link
                            href="/playlists"
                            prefetch={false}
                            className="group/link"
                        >
                            <span className="text-xs font-medium text-[var(--text-muted)] group-hover/link:text-brand transition-colors">
                                Playlist Stack
                            </span>
                        </Link>
                    </div>
                    <div className="relative" ref={createPopoverRef}>
                        <button
                            onClick={() => {
                                setShowCreatePlaylist((v) => !v);
                                setNewPlaylistName("");
                            }}
                            className="w-6 h-6 flex items-center justify-center bg-[var(--bg-primary)] border-2 border-white/10 text-[var(--text-muted)] hover:text-brand hover:border-brand/50 hover:bg-brand/5 transition-all duration-200"
                            aria-label="Create playlist"
                            title="create playlist"
                        >
                            <Plus className="w-3.5 h-3.5" />
                        </button>
                        {showCreatePlaylist && (
                            <div className="absolute right-0 top-8 z-(--z-dropdown) w-56 bg-[var(--bg-hover)] border border-white/10 rounded-lg p-3">
                                <input
                                    type="text"
                                    value={newPlaylistName}
                                    onChange={(e) =>
                                        setNewPlaylistName(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                            handleCreatePlaylist();
                                        if (e.key === "Escape") {
                                            e.preventDefault();
                                            setShowCreatePlaylist(false);
                                            setNewPlaylistName("");
                                        }
                                    }}
                                    placeholder="Playlist name"
                                    autoFocus
                                    className="w-full bg-[var(--bg-primary)] border border-white/10 rounded px-2.5 py-1.5 text-xs text-white placeholder-gray-600 outline-none focus:border-brand/50 transition-colors"
                                />
                                <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={handleCreatePlaylist}
                                    disabled={
                                        !newPlaylistName.trim() || isCreating
                                    }
                                    className="mt-2 w-full"
                                >
                                    {isCreating ? "Creating..." : "Create"}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
                <div
                    className="flex-1 overflow-y-auto space-y-0.5 scrollbar-thin scrollbar-thumb-[#1c1c1c] scrollbar-track-transparent px-3"
                >
                    {isLoadingPlaylists ?
                        <>
                            {[1, 2, 3, 4, 5].map((i) => (
                                <div
                                    key={i}
                                    className="px-2 py-2 bg-[var(--bg-primary)] border-l-2 border-transparent"
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
                                            "flex items-center gap-3 py-2 px-2 border-l-2 transition-all duration-200 group",
                                            isActive ?
                                                "bg-[var(--bg-primary)] border-brand text-white"
                                            :   "border-transparent text-[var(--text-muted)] hover:text-white hover:bg-white/5 hover:border-white/20",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "w-5 t-meta font-semibold text-center shrink-0 transition-colors duration-200",
                                                isActive ? "text-brand" : (
                                                    "text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]"
                                                ),
                                            )}
                                        >
                                            {String(index + 1).padStart(2, "0")}
                                        </span>

                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <div
                                                    className={cn(
                                                        "text-xs font-semibold tracking-tight truncate transition-colors duration-200",
                                                        isActive ? "text-white"
                                                        :   "group-hover:text-white",
                                                    )}
                                                >
                                                    {playlist.name}
                                                </div>
                                                {isShared && (
                                                    <span
                                                        className="shrink-0 w-1 h-1 rounded-full bg-brand"
                                                        title={`Shared by ${
                                                            playlist.user
                                                                ?.username ||
                                                            "someone"
                                                        }`.toLowerCase()}
                                                    />
                                                )}
                                            </div>
                                            <div
                                                className={cn(
                                                    "t-meta truncate mt-0.5 transition-colors duration-200",
                                                    isActive ? ""
                                                    : "group-hover:text-[var(--text-secondary)]",
                                                )}
                                            >
                                                {playlist.trackCount}{" "}
                                                {playlist.trackCount === 1 ? "track" : "tracks"}
                                                {isShared &&
                                                    ` • ${playlist.user?.username || "Shared"}`}
                                            </div>
                                        </div>
                                    </Link>
                                );
                            })
                    :   <div className="px-2 py-6 border-l-2 border-transparent">
                            <div className="text-xs text-[var(--text-muted)] mb-1">
                                Empty Stack
                            </div>
                            <div className="text-micro text-[var(--text-muted)]">
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
            {isMobileOrTablet && (
                <MobileSidebar
                    isOpen={isMobileMenuOpen}
                    onClose={() => setIsMobileMenuOpen(false)}
                />
            )}

            {!isMobileOrTablet && (
                <aside className="w-64 bg-[var(--bg-primary)] flex flex-col overflow-hidden relative z-(--z-raised) rounded-lg">
                    {sidebarContent}
                </aside>
            )}
        </>
    );
}
