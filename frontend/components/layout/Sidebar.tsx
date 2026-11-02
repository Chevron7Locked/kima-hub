"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
    ChevronLeft,
    ChevronRight,
    ListMusic,
    Music,
    Plus,
    RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    queryKeys,
    useMixesQuery,
    useRefreshMixesMutation,
} from "@/hooks/useQueries";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useClickOutside } from "@/hooks/useClickOutside";
import { notify } from "@/lib/notify";
import { useFeatures } from "@/lib/features-context";
import { mosaicCovers } from "@/features/playlist/coverMosaic";
import { CachedImage } from "@/components/ui/CachedImage";
import { SideTooltip } from "@/components/ui/SideTooltip";
import { CoverArt } from "@/components/cards/MediaCard";
import { MobileSidebar } from "./MobileSidebar";
import { NAV, isCurrentNav, type NavItem } from "./navItems";
import type { Mix } from "@/features/home/types";

const primaryNavigation: NavItem[] = [NAV.collection, NAV.radio, NAV.discover, NAV.releases, NAV.vibe];
const secondaryNavigation: NavItem[] = [NAV.audiobooks, NAV.podcasts, NAV.browse, NAV.stats];

interface Playlist {
    id: string;
    name: string;
    trackCount: number;
    isHidden?: boolean;
    isOwner?: boolean;
    user?: { username: string };
    items?: {
        track?: { album?: { coverUrl?: string } };
    }[];
}

const COLLAPSE_KEY = "kima:library-collapsed";
const OPEN_WIDTH = 256;
const CLOSED_WIDTH = 74;
/** The collapsed handle's width (its `w-4`); the panel slides to exactly this far from the rail so its edge travels with the box's. */
const HANDLE_WIDTH = 16;
/** The library panel's own width beside the 56px rail, inside the 1px border: fixed, so a slide never squeezes it. */
const PANEL_WIDTH = OPEN_WIDTH - 56 - 2;

// The stored choice is read before the first paint: the server has no
// localStorage, so the server snapshot is the open shelf and the client snapshot
// replaces it before paint instead of animating the shelf shut on every load.
let storedCollapsed: boolean | null = null;
const collapseListeners = new Set<() => void>();

function readCollapsed(): boolean {
    if (storedCollapsed === null) {
        try {
            storedCollapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
        } catch {
            // A blocked storage API leaves the shelf open, which is the safe default.
            return false;
        }
    }
    return storedCollapsed;
}

function subscribeCollapsed(listener: () => void) {
    collapseListeners.add(listener);
    return () => {
        collapseListeners.delete(listener);
    };
}

function writeCollapsed(next: boolean) {
    storedCollapsed = next;
    try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
    } catch {
        // The choice simply does not survive this session.
    }
    collapseListeners.forEach((listener) => listener());
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
    const [filter, setFilter] = useState("");
    const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
    const createButtonRef = useRef<HTMLButtonElement>(null);
    const createInputRef = useRef<HTMLInputElement>(null);
    const handleRef = useRef<HTMLButtonElement>(null);
    const collapseButtonRef = useRef<HTMLButtonElement>(null);

    const {
        data: playlists = [],
        isLoading: isLoadingPlaylists,
        isError: isErrorPlaylists,
        refetch: refetchPlaylists,
    } = useQuery<Playlist[]>({
        queryKey: ["playlists"],
        queryFn: () => api.getPlaylists(),
        enabled: isAuthenticated,
    });

    const {
        data: mixes = [],
        isLoading: isLoadingMixes,
        isError: isErrorMixes,
        refetch: refetchMixes,
    } = useMixesQuery();
    const { mutate: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    const visiblePlaylists = playlists.filter((p) => !p.isHidden);
    const ownPlaylists = visiblePlaylists.filter((p) => p.isOwner !== false);
    const sharedPlaylists = visiblePlaylists.filter((p) => p.isOwner === false);

    const query = filter.trim().toLowerCase();
    const matches = (name: string) =>
        query.length === 0 || name.toLowerCase().includes(query);

    const shownOwn = ownPlaylists.filter((p) => matches(p.name));
    const shownShared = sharedPlaylists.filter((p) => matches(p.name));
    const shownMixes = mixes.filter((m) => matches(m.name));
    const nothingMatches =
        query.length > 0 &&
        shownOwn.length === 0 &&
        shownShared.length === 0 &&
        shownMixes.length === 0;

    const isCurrent = (item: NavItem) => isCurrentNav(item, pathname);

    const secondaryItems = secondaryNavigation.filter(
        (item) =>
            !item.feature ||
            (item.feature === "audiobookshelfEnabled" && audiobookshelfEnabled)
    );

    const [lastPathname, setLastPathname] = useState(pathname);
    if (pathname !== lastPathname) {
        setLastPathname(pathname);
        setIsMobileMenuOpen(false);
    }

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

    useClickOutside(
        [createButtonRef, createInputRef],
        () => {
            setShowCreatePlaylist(false);
            setNewPlaylistName("");
        },
        showCreatePlaylist,
    );

    const closeCreate = () => {
        setShowCreatePlaylist(false);
        setNewPlaylistName("");
        createButtonRef.current?.focus();
    };

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
            notify.error("couldn't create the playlist");
        } finally {
            setIsCreating(false);
        }
    };

    const collapse = () => {
        writeCollapsed(true);
        requestAnimationFrame(() => handleRef.current?.focus());
    };

    const coverFor = (playlist: Playlist) =>
        mosaicCovers(
            (playlist.items ?? []).map((item) => item.track?.album?.coverUrl)
        )[0];

    const playlistRow = (playlist: Playlist) => {
        const isActive = pathname === `/playlist/${playlist.id}`;
        const cover = coverFor(playlist);
        const shared = playlist.isOwner === false;
        return (
            <Link
                key={playlist.id}
                href={`/playlist/${playlist.id}`}
                prefetch={false}
                aria-current={isActive ? "page" : undefined}
                aria-label={`${playlist.name}, ${playlist.trackCount} ${
                    playlist.trackCount === 1 ? "song" : "songs"
                }${shared ? `, shared by ${playlist.user?.username || "someone else"}` : ""}`}
                title={playlist.name}
                className={cn(
                    "group flex h-10 items-center gap-2 rounded-[9px] px-2 outline-none transition-colors duration-150",
                    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60",
                    isActive
                        ? "bg-brand/[0.08]"
                        : "hover:bg-white/[0.055]"
                )}
            >
                <span className="relative h-7 w-7 shrink-0 overflow-hidden rounded-md bg-white/[0.05]">
                    {cover ? (
                        <CachedImage
                            src={api.getCoverArtUrl(cover, 96)}
                            alt=""
                            fill
                            sizes="28px"
                            className="object-cover"
                        />
                    ) : (
                        <ListMusic
                            aria-hidden="true"
                            className="absolute inset-0 m-auto h-3.5 w-3.5 text-[var(--text-muted)]"
                        />
                    )}
                </span>
                <span
                    className={cn(
                        "min-w-0 flex-1 truncate text-[13px] tracking-[-0.01em] transition-colors duration-150",
                        isActive
                            ? "font-medium text-brand"
                            : "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
                    )}
                >
                    {playlist.name}
                </span>
                <span
                    className={cn(
                        "shrink-0 text-[11px] tabular-nums transition-colors duration-150",
                        isActive
                            ? "text-brand/70"
                            : "text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]"
                    )}
                >
                    {playlist.trackCount}
                </span>
            </Link>
        );
    };

    const sectionLabel = (label: string, count: number, action?: ReactNode) => (
        <h2 className="sticky top-0 z-[2] flex items-center justify-between gap-2 bg-[var(--bg-secondary)] px-2 pb-1 pt-2.5 text-micro font-normal text-[var(--text-muted)]">
            <span className="tracking-[0.06em]">{label}</span>
            <span className="flex items-center gap-1.5">
                {action}
                <span className="tabular-nums">{count}</span>
            </span>
        </h2>
    );

    const refreshMixesButton = (
        <button
            type="button"
            onClick={() => refreshMixes()}
            disabled={isRefreshingMixes}
            aria-label="refresh today's mixes"
            className="-my-1 flex h-6 w-6 items-center justify-center rounded-md outline-none transition-colors duration-150 hover:bg-white/[0.06] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-brand/60 disabled:pointer-events-none"
        >
            <RefreshCw
                aria-hidden="true"
                className={cn("h-3 w-3", isRefreshingMixes && "animate-spin text-brand")}
            />
        </button>
    );

    // The same artwork as the home page's mixes: the covers of the mix's albums, as one cover or a 2x2 mosaic.
    const mixTiles = (items: Mix[]) => (
        <div className="grid grid-cols-2 gap-x-2 gap-y-2.5 pb-1 pt-0.5">
            {items.map((mix) => {
                const isActive = pathname === `/mix/${mix.id}`;
                return (
                    <Link
                        key={mix.id}
                        href={`/mix/${mix.id}`}
                        prefetch={false}
                        aria-current={isActive ? "page" : undefined}
                        title={(mix.description || mix.name).toLowerCase()}
                        className="group min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                        <span
                            className={cn(
                                "relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-white/[0.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)]",
                                isActive && "ring-2 ring-brand/70"
                            )}
                        >
                            <CoverArt
                                key={mix.id}
                                imageUrl={(mix.coverUrls ?? []).slice(0, 4).map((url) => api.getCoverArtUrl(url, 200))}
                                title=""
                                sizes="112px"
                                FallbackIcon={Music}
                            />
                        </span>
                        <span
                            className={cn(
                                "mt-1 line-clamp-2 text-[11px] leading-[1.25] transition-colors duration-150",
                                isActive
                                    ? "text-brand"
                                    : "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
                            )}
                        >
                            {mix.name}
                        </span>
                    </Link>
                );
            })}
        </div>
    );

    const railLink = (item: NavItem) => {
        const isActive = isCurrent(item);
        const Icon = item.icon;
        return (
            <SideTooltip key={item.href} label={item.name}>
                <Link
                    href={item.href}
                    prefetch={false}
                    aria-current={isActive ? "page" : undefined}
                    aria-label={item.name}
                    className={cn(
                        "group flex h-10 w-10 items-center justify-center rounded-xl outline-none transition-[background-color,color,box-shadow] duration-150",
                        "focus-visible:ring-2 focus-visible:ring-brand/60",
                        isActive
                            ? "bg-[linear-gradient(100deg,rgba(252,162,0,0.16),rgba(252,162,0,0.04))] text-brand shadow-[inset_0_0_0_1px_rgba(252,162,0,0.2)]"
                            : "text-[var(--text-muted)] hover:bg-white/[0.05] hover:text-[var(--text-secondary)]"
                    )}
                >
                    <Icon
                        aria-hidden="true"
                        strokeWidth={isActive ? 2 : 1.6}
                        className="h-5 w-5 transition-transform duration-150 group-hover:scale-[1.06]"
                    />
                </Link>
            </SideTooltip>
        );
    };

    // Render sidebar content inline to prevent component recreation
    const sidebarContent = (
        <>
            {/* The rail: surfaces at the top, the four corners of the library at
                the foot. */}
            <nav
                className="relative z-[1] flex w-14 shrink-0 flex-col items-center justify-between border-r border-white/[0.05] bg-[#070707] py-2.5"
                aria-label="main navigation"
            >
                <div className="flex flex-col items-center gap-1">
                    {primaryNavigation.map(railLink)}
                </div>
                <div className="flex flex-col items-center gap-1">
                    {secondaryItems.map(railLink)}
                </div>
            </nav>

            {/* The panel slides out from under the rail and back; collapsed, it leaves the row so the handle takes its
                place. */}
            <div
                className={cn(
                    "flex shrink-0 flex-col overflow-hidden bg-[var(--bg-secondary)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
                    collapsed && "pointer-events-none absolute inset-y-0 left-14 opacity-0"
                )}
                style={{ width: PANEL_WIDTH, transform: collapsed ? `translateX(-${PANEL_WIDTH - HANDLE_WIDTH}px)` : "none" }}
                inert={collapsed}
                aria-hidden={collapsed || undefined}
            >
                <div className="flex h-11 shrink-0 items-center justify-between pl-2.5 pr-1.5">
                    <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-secondary)]">
                        library
                    </span>
                    <span className="flex items-center gap-0.5">
                        <button
                            ref={createButtonRef}
                            type="button"
                            onClick={() => {
                                setShowCreatePlaylist((v) => !v);
                                setNewPlaylistName("");
                            }}
                            aria-label="create playlist"
                            aria-expanded={showCreatePlaylist}
                            title="create playlist"
                            className={cn(
                                "flex h-6 w-6 items-center justify-center rounded-md outline-none transition-colors duration-150",
                                "text-[var(--text-muted)] hover:bg-white/[0.06] hover:text-brand",
                                "focus-visible:ring-2 focus-visible:ring-brand/60",
                                showCreatePlaylist && "text-brand"
                            )}
                        >
                            <Plus
                                aria-hidden="true"
                                strokeWidth={2}
                                className={cn(
                                    "h-3.5 w-3.5 transition-transform duration-200 ease-[cubic-bezier(0.25,1,0.5,1)]",
                                    showCreatePlaylist && "rotate-45"
                                )}
                            />
                        </button>
                        <button
                            ref={collapseButtonRef}
                            type="button"
                            onClick={collapse}
                            aria-label="hide library"
                            title="hide library"
                            className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] outline-none transition-colors duration-150 hover:bg-white/[0.06] hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/60"
                        >
                            <ChevronLeft
                                aria-hidden="true"
                                className="h-4 w-4"
                            />
                        </button>
                    </span>
                </div>

                <div className="mx-2 mb-1 flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.05] bg-white/[0.035] px-2 text-[var(--text-muted)] focus-within:border-brand/45 focus-within:bg-white/[0.05]">
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-3 w-3 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                    >
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="filter library"
                        aria-label="filter library"
                        className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                    />
                </div>

                {showCreatePlaylist && (
                    <input
                        ref={createInputRef}
                        type="text"
                        value={newPlaylistName}
                        onChange={(e) => setNewPlaylistName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") handleCreatePlaylist();
                            if (e.key === "Escape") {
                                e.preventDefault();
                                closeCreate();
                            }
                        }}
                        placeholder="playlist name"
                        autoFocus
                        enterKeyHint="done"
                        aria-label="new playlist name"
                        className="mx-2 mb-1 h-8 shrink-0 rounded-lg border border-white/10 bg-[var(--bg-tertiary)] px-2 text-[13px] text-[var(--text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--text-muted)] focus:border-brand/50"
                    />
                )}

                <nav
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 [scrollbar-color:rgba(255,255,255,0.12)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:bg-transparent"
                    aria-label="library"
                >
                    {isLoadingPlaylists ? (
                        <div className="space-y-1 pt-1">
                            {[1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="flex h-10 animate-pulse items-center gap-2 rounded-[9px] px-2"
                                >
                                    <div className="h-7 w-7 rounded-md bg-white/[0.05]" />
                                    <div className="h-2.5 flex-1 rounded bg-white/[0.05]" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <>
                            {(query.length === 0 || shownOwn.length > 0 || isErrorPlaylists) && (
                                <section>
                                    {sectionLabel("playlists", shownOwn.length)}
                                    {isErrorPlaylists ? (
                                        <div className="px-2 py-3">
                                            <p className="text-xs text-[var(--text-muted)]">
                                                couldn&apos;t load playlists
                                            </p>
                                            <button
                                                type="button"
                                                onClick={() => refetchPlaylists()}
                                                className="mt-1 rounded text-xs text-[var(--text-secondary)] outline-none transition-colors hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/60"
                                            >
                                                try again
                                            </button>
                                        </div>
                                    ) : shownOwn.length > 0 ? (
                                        shownOwn.map(playlistRow)
                                    ) : query.length === 0 ? (
                                        <div className="px-2 py-2">
                                            <p className="text-xs text-[var(--text-muted)]">
                                                none of your own yet
                                            </p>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowCreatePlaylist(true);
                                                    setNewPlaylistName("");
                                                }}
                                                className="mt-1 rounded text-xs text-[var(--text-secondary)] outline-none transition-colors hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/60"
                                            >
                                                make the first one
                                            </button>
                                        </div>
                                    ) : null}
                                </section>
                            )}

                            {(shownShared.length > 0 ||
                                (query.length === 0 &&
                                    sharedPlaylists.length === 0)) && (
                                <section>
                                    {sectionLabel(
                                        "shared",
                                        shownShared.length
                                    )}
                                    {shownShared.length > 0 ? (
                                        shownShared.map(playlistRow)
                                    ) : (
                                        <p className="px-2 py-2 text-xs text-[var(--text-muted)]">
                                            nothing shared with you yet
                                        </p>
                                    )}
                                </section>
                            )}

                            {(shownMixes.length > 0 ||
                                (query.length === 0 &&
                                    (isLoadingMixes ||
                                        isErrorMixes ||
                                        mixes.length === 0))) && (
                                <section>
                                    {sectionLabel(
                                        "daily mixes",
                                        shownMixes.length,
                                        refreshMixesButton
                                    )}
                                    {isLoadingMixes ? (
                                        <div className="grid grid-cols-2 gap-2 pb-1 pt-0.5">
                                            {[1, 2, 3, 4, 5, 6].map((i) => (
                                                <div key={i}>
                                                    <div className="aspect-square animate-pulse rounded-lg bg-white/[0.05]" />
                                                    <div className="mt-1 h-2 w-3/4 animate-pulse rounded bg-white/[0.04]" />
                                                </div>
                                            ))}
                                        </div>
                                    ) : isErrorMixes ? (
                                        <div className="px-2 py-3">
                                            <p className="text-xs text-[var(--text-muted)]">
                                                couldn&apos;t load today&apos;s mixes
                                            </p>
                                            <button
                                                type="button"
                                                onClick={() => refetchMixes()}
                                                className="mt-1 rounded text-xs text-[var(--text-secondary)] outline-none transition-colors hover:text-brand focus-visible:ring-2 focus-visible:ring-brand/60"
                                            >
                                                try again
                                            </button>
                                        </div>
                                    ) : shownMixes.length > 0 ? (
                                        mixTiles(shownMixes)
                                    ) : (
                                        <p className="px-2 py-2 text-xs text-[var(--text-muted)]">
                                            no mixes yet: refresh to make today&apos;s
                                        </p>
                                    )}
                                </section>
                            )}

                            {nothingMatches && (
                                <p className="px-2 py-3 text-xs text-[var(--text-muted)]">
                                    nothing matches that filter
                                </p>
                            )}
                        </>
                    )}
                </nav>

                <div className="flex h-9 shrink-0 items-center justify-between border-t border-white/[0.05] px-3 text-xs text-[var(--text-muted)]">
                    <Link
                        href="/playlists"
                        prefetch={false}
                        className="rounded outline-none transition-colors duration-150 hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-brand/60"
                    >
                        all playlists
                    </Link>
                    <span className="text-[11px] tabular-nums">
                        {visiblePlaylists.length}
                    </span>
                </div>
            </div>

            {collapsed && (
                <button
                    ref={handleRef}
                    type="button"
                    onClick={() => {
                        writeCollapsed(false);
                        requestAnimationFrame(() =>
                            collapseButtonRef.current?.focus()
                        );
                    }}
                    aria-label="show library"
                    title="show library"
                    className="group flex w-4 shrink-0 flex-col items-center border-l border-white/[0.05] bg-[#0b0b0b] pt-3 outline-none transition-colors duration-150 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60 animate-fade-soft"
                >
                    <ChevronRight
                        aria-hidden="true"
                        className="h-3.5 w-3.5 text-[var(--text-muted)] transition-colors duration-150 group-hover:text-brand"
                    />
                </button>
            )}
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
                <div
                    // The page beside the sidebar is laid out once, by this placeholder's width: at the END of opening
                    // (the box slides over the page, then the page settles) and at the START of closing (the page
                    // widens under the box as it shrinks, so the strip it uncovers is already page, never a gap). The
                    // visible box below is out of flow, so animating it never lays the page out. It sits above the page's own raised
                    // content (carousel arrows, sticky bars) and under the top bar, so nothing paints over it mid-slide.
                    className={cn(
                        "relative z-(--z-scene-panel) shrink-0",
                        collapsed
                            ? "[transition:width_0s]"
                            : "[transition:width_0s_300ms] motion-reduce:[transition:width_0s]"
                    )}
                    style={{ width: collapsed ? CLOSED_WIDTH : OPEN_WIDTH }}
                >
                    <aside
                        className="absolute inset-y-0 left-0 flex overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] transition-[width] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none"
                        style={{ width: collapsed ? CLOSED_WIDTH : OPEN_WIDTH }}
                    >
                        {sidebarContent}
                    </aside>
                </div>
            )}
        </>
    );
}
