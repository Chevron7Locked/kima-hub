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
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SideTooltip } from "@/components/ui/SideTooltip";
import { CoverArt } from "@/components/cards/MediaCard";
import { MobileSidebar } from "./MobileSidebar";
import { NAV, isCurrentNav, type NavItem } from "./navItems";
import { panelCurrentBar, panelIconButton } from "./panelChrome";
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

/** A next step the empty library offers. */
const libraryAction =
    "rounded text-sm font-medium text-brand outline-none transition-colors duration-150 hover:text-brand-hover focus-visible:ring-2 focus-visible:ring-brand/60 disabled:opacity-60";

const COLLAPSE_KEY = "kima:library-collapsed";
const OPEN_WIDTH = 280;
const CLOSED_WIDTH = 80;
/** The collapsed handle's width (its `w-6`); the panel slides to exactly this far from the rail so its edge travels with the box's. */
const HANDLE_WIDTH = 24;
/** The library panel's own width beside the 56px rail: fixed, so a slide never squeezes it. */
const PANEL_WIDTH = OPEN_WIDTH - 56;

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
    // Nothing to show at all: one line and what to do about it, not one empty message per section.
    const libraryEmpty =
        query.length === 0 &&
        visiblePlaylists.length === 0 &&
        mixes.length === 0 &&
        !isLoadingMixes &&
        !isErrorPlaylists &&
        !isErrorMixes;
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
                    "group flex h-12 items-center gap-2.5 rounded-lg px-2 outline-none",
                    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60",
                    isActive && panelCurrentBar
                )}
            >
                <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-white/[0.05] transition-[filter] duration-150 group-hover:brightness-110">
                    {cover ? (
                        <CachedImage
                            src={api.getCoverArtUrl(cover, 96)}
                            alt=""
                            fill
                            sizes="40px"
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
                        "min-w-0 flex-1 truncate text-sm font-medium tracking-tight transition-colors duration-150",
                        isActive
                            ? "text-brand"
                            : "text-[var(--text-primary)] group-hover:text-white"
                    )}
                >
                    {playlist.name}
                </span>
                <span
                    className={cn(
                        "t-meta shrink-0 transition-colors duration-150",
                        isActive
                            ? "text-brand/80"
                            : "group-hover:text-[var(--text-secondary)]"
                    )}
                >
                    {playlist.trackCount}
                </span>
            </Link>
        );
    };

    const sectionLabel = (label: string, count: number, action?: ReactNode) => (
        <SectionHeader
            size="xs"
            type="track"
            title={label}
            count={count}
            action={action}
            className="sticky top-0 z-[2] bg-[var(--bg-chrome)] px-2 pb-1 pt-4"
        />
    );

    const allPlaylistsLink = (
        <Link
            href="/playlists"
            prefetch={false}
            aria-label="all playlists"
            className="flex items-center gap-0.5 rounded text-xs text-[var(--text-secondary)] outline-none transition-colors duration-150 hover:text-white focus-visible:ring-2 focus-visible:ring-brand/60"
        >
            show all
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
    );

    const refreshMixesButton = (
        <button
            type="button"
            onClick={() => refreshMixes()}
            disabled={isRefreshingMixes}
            aria-label="refresh today's mixes"
            className={cn(panelIconButton, "-my-1 h-6 w-6")}
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
                                "relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-white/[0.04] transition-[filter] duration-150 group-hover:brightness-110",
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
                                "mt-1.5 line-clamp-2 text-xs font-medium leading-[1.25] transition-colors duration-150",
                                isActive
                                    ? "text-brand"
                                    : "text-[var(--text-secondary)] group-hover:text-white"
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
                        "group flex h-10 w-10 items-center justify-center rounded-full outline-none transition-colors duration-150",
                        "focus-visible:ring-2 focus-visible:ring-brand/60",
                        isActive
                            ? cn("text-brand", panelCurrentBar)
                            : "text-[var(--text-secondary)] hover:text-white"
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
                className="relative z-[1] flex w-14 shrink-0 flex-col items-center justify-between bg-[var(--bg-chrome)] py-2.5"
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
                    "flex shrink-0 flex-col overflow-hidden bg-[var(--bg-chrome)] transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
                    collapsed && "pointer-events-none absolute inset-y-0 left-14 opacity-0"
                )}
                style={{ width: PANEL_WIDTH, transform: collapsed ? `translateX(-${PANEL_WIDTH - HANDLE_WIDTH}px)` : "none" }}
                inert={collapsed}
                aria-hidden={collapsed || undefined}
            >
                <div className="flex h-12 shrink-0 items-center justify-between pl-3 pr-1.5">
                    <span className="truncate text-lg font-bold tracking-tight text-white">
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
                            className={cn(panelIconButton, showCreatePlaylist && "text-brand hover:text-brand")}
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
                            className={panelIconButton}
                        >
                            <ChevronLeft
                                aria-hidden="true"
                                className="h-4 w-4"
                            />
                        </button>
                    </span>
                </div>

                <div className="mx-2 mb-1 flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--bg-hover)] px-3 text-[var(--text-secondary)] focus-within:ring-2 focus-within:ring-brand/60">
                    <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5 shrink-0"
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
                        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
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
                                    className="flex h-12 animate-pulse items-center gap-2.5 rounded-lg px-2"
                                >
                                    <div className="h-10 w-10 rounded-md bg-white/[0.05]" />
                                    <div className="h-2.5 flex-1 rounded bg-white/[0.05]" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <>
                            {libraryEmpty && (
                                <div className="px-2 pt-4">
                                    <p className="t-body">your playlists and daily mixes will show up here.</p>
                                    <div className="mt-2 flex flex-col items-start gap-1.5">
                                        {[
                                            { label: "make a playlist", run: () => { setShowCreatePlaylist(true); setNewPlaylistName(""); } },
                                            { label: "make today's mixes", run: () => refreshMixes(), busy: isRefreshingMixes },
                                        ].map(({ label, run, busy }) => (
                                            <button
                                                key={label}
                                                type="button"
                                                onClick={run}
                                                disabled={busy}
                                                className={libraryAction}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                        {playlists.length > 0 && allPlaylistsLink}
                                    </div>
                                </div>
                            )}

                            {!libraryEmpty && (query.length === 0 || shownOwn.length > 0 || isErrorPlaylists) && (
                                <section>
                                    {sectionLabel("playlists", shownOwn.length, allPlaylistsLink)}
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
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setShowCreatePlaylist(true);
                                                    setNewPlaylistName("");
                                                }}
                                                className={libraryAction}
                                            >
                                                make your first playlist
                                            </button>
                                        </div>
                                    ) : null}
                                </section>
                            )}

                            {shownShared.length > 0 && (
                                <section>
                                    {sectionLabel(
                                        "shared",
                                        shownShared.length
                                    )}
                                    {shownShared.map(playlistRow)}
                                </section>
                            )}

                            {!libraryEmpty && (shownMixes.length > 0 ||
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
                                            refresh to make today&apos;s mixes
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
                    className="group flex w-6 shrink-0 flex-col items-center bg-[var(--bg-chrome)] pt-3 outline-none transition-colors duration-150 hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/60 animate-fade-soft"
                >
                    <ChevronRight
                        aria-hidden="true"
                        className="h-3.5 w-3.5 text-[var(--text-secondary)] transition-colors duration-150 group-hover:text-white"
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
                    // This placeholder's width pushes and pulls the page beside the sidebar, on the same curve and timing as
                    // the visible box below, so the page follows the slide; the box sits above the page's raised content
                    // and under the top bar.
                    className="relative z-(--z-scene-panel) shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none"
                    style={{ width: collapsed ? CLOSED_WIDTH : OPEN_WIDTH }}
                >
                    <aside
                        className="absolute inset-y-0 left-0 flex overflow-hidden bg-[var(--bg-chrome)] transition-[width] duration-300 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none"
                        style={{ width: collapsed ? CLOSED_WIDTH : OPEN_WIDTH }}
                    >
                        {sidebarContent}
                    </aside>
                </div>
            )}
        </>
    );
}
