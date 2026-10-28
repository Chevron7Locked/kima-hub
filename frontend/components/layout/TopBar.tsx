"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
    Home,
    Search,
    Settings,
    RefreshCw,
    Power,
    Menu,
    Bell,
} from "lucide-react";
import { ActivityPanelToggle } from "./ActivityPanel";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { useDownloadContext } from "@/lib/download-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useActivityPanelOpen } from "@/hooks/useActivityPanel";
import { useAuth } from "@/lib/auth-context";
import { APP_VERSION } from "@/lib/version";
import { openWhatsNewOrChangelog } from "@/components/whats-new/WhatsNewGate";
import { useVersionChip } from "@/components/whats-new/useVersionChip";
import { KimaMark } from "@/components/ui/KimaMark";

const scanEnded = (status?: string) => status === "completed" || status === "failed";

export function TopBar() {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { logout, user } = useAuth();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [searchQuery, setSearchQuery] = useState("");
    const [scanJobId, setScanJobId] = useState<string | null>(null);
    const chip = useVersionChip();
    const isActivityPanelOpen = useActivityPanelOpen();
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const queryClient = useQueryClient();

    // The scan's state from the server. SSE events update it as they arrive; it
    // is also read every 2 s until the scan ends, so a missed event cannot leave
    // the button spinning.
    const { data: scanStatus } = useQuery<{
        status: string;
        progress: number;
        jobId: string;
        error?: string;
    } | null>({
        queryKey: ["scan-status", scanJobId],
        queryFn: async () => {
            try {
                return { ...(await api.getScanStatus(scanJobId!)), jobId: scanJobId! };
            } catch (error) {
                if ((error as { status?: number }).status === 404) return { status: "completed", progress: 100, jobId: scanJobId! };
                throw error;
            }
        },
        enabled: !!scanJobId,
        refetchInterval: (query) => (scanEnded(query.state.data?.status) ? false : 2000),
    });

    const isPolling = !!scanJobId && !scanEnded(scanStatus?.status);

    if (scanStatus && scanJobId && scanEnded(scanStatus.status)) {
        setScanJobId(null);
    }

    // Track download status from context (single source of truth)
    const { pendingDownloads, downloadStatus } = useDownloadContext();
    // Only use API-driven state for the icon
    // pendingDownloads is optimistic local state that can become stale
    const hasActiveDownloads = downloadStatus.hasActiveDownloads;

    // Only count recent pending uploads; `now` advances when the oldest one ages out
    const [now, setNow] = useState(() => Date.now());
    const hasPendingUploads = pendingDownloads.some((p) => now - p.timestamp < 30000);

    useEffect(() => {
        const t = Date.now();
        const recent = pendingDownloads.filter((p) => t - p.timestamp < 30000);
        if (recent.length === 0) return;
        const nextExpiry = Math.min(...recent.map((p) => p.timestamp + 30000));
        const id = setTimeout(() => setNow(Date.now()), nextExpiry - t + 1);
        return () => clearTimeout(id);
    }, [pendingDownloads, now]);

    const handleSync = async () => {
        if (isPolling) return;

        try {
            const response = await api.scanLibrary();
            // Every manual scan has the same job id; the last scan's "completed"
            // must not stand in for this one.
            queryClient.removeQueries({ queryKey: ["scan-status", response.jobId] });
            setScanJobId(response.jobId);
        } catch (error) {
            // A refused scan never starts, so nothing else reports it.
            const message =
                error instanceof Error ? error.message : String(error);
            const refused = /403|forbidden|admin/i.test(message);
            notify.error(
                refused
                    ? "Only an admin can scan the library"
                    : "Could not start the library scan"
            );
        }
    };

    const handleLogout = async () => {
        try {
            await logout();
        } catch {
            notify.error("Failed to logout");
        }
    };

    const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (searchQuery.trim()) {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }
    };

    // Auto-search with debounce (500ms after user stops typing)
    useEffect(() => {
        // Don't auto-search if we're already on the search page with the same query
        const params = new URLSearchParams(window.location.search);
        const currentQuery = params.get("q");
        if (pathname === "/search" && currentQuery === searchQuery.trim()) {
            return;
        }

        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        if (!searchQuery.trim()) {
            return;
        }

        // Set new timeout to trigger search after 500ms of no typing
        searchTimeoutRef.current = setTimeout(() => {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }, 500);

        // Cleanup timeout on unmount or when searchQuery changes
        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery, router, pathname]);

    // Sync search query with URL on page change
    const [syncedPathname, setSyncedPathname] = useState<string | null>(null);
    if (pathname !== syncedPathname) {
        setSyncedPathname(pathname);
        const q = searchParams.get("q");

        if (pathname === "/search" && q) {
            // Only update if different to avoid loops
            if (q !== searchQuery) {
                setSearchQuery(q);
            }
        } else if (pathname !== "/search" && searchQuery) {
            // Clear search when leaving search page
            setSearchQuery("");
        }
    }

    // Global "/" keyboard shortcut to focus search
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) {
                    return;
                }
                e.preventDefault();
                searchInputRef.current?.focus();
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, []);

    return (
        <header
            className="fixed top-0 left-0 right-0 bg-black flex items-center px-3 z-(--z-header) pwa-titlebar-drag"
            style={{
                height: isMobileOrTablet
                    ? "calc(var(--topbar-h) + var(--standalone-safe-area-top, 0px))"
                    : "calc(64px + var(--titlebar-height, 0px))",
                paddingTop: isMobileOrTablet
                    ? "var(--standalone-safe-area-top, 0px)"
                    : "var(--titlebar-height, 0px)",
            }}
        >
            {/* Mobile/Tablet Layout: Hamburger + Home + Search + Bell */}
            {isMobileOrTablet ? (
                <>
                    <button
                        onClick={() => {
                            window.dispatchEvent(
                                new CustomEvent("toggle-mobile-menu")
                            );
                        }}
                        className="w-11 h-11 flex items-center justify-center bg-[var(--bg-secondary)] border border-[var(--border-interactive)] rounded-md text-white hover:bg-[var(--bg-tertiary)] transition-colors duration-200 mr-2 flex-shrink-0"
                        aria-label="Open menu"
                    >
                        <Menu className="w-5 h-5" />
                    </button>

                    <Link
                        href="/"
                        className={cn(
                                "w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 flex-shrink-0 mr-2",
                            pathname === "/"
                                ? "bg-white text-black"
                                : "bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white"
                        )}
                        aria-label="Home"
                        title="home"
                    >
                        <Home className="w-5 h-5" />
                    </Link>

                    <form onSubmit={handleSearch} className="flex-1 min-w-0">
                        <div
                            className="relative"
                            data-tv-section="search-input"
                        >
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search..."
                                aria-label="Search"
                                autoCapitalize="none"
                                autoCorrect="off"
                                tabIndex={0}
                                className="w-full h-11 pl-10 pr-3 bg-[var(--bg-hover)] hover:bg-[#242424] border-2 border-transparent focus:border-white/20 rounded-full text-sm text-white placeholder-gray-400 transition-all duration-200 outline-none"
                            />
                        </div>
                    </form>

                    <button
                        onClick={() => {
                            window.dispatchEvent(
                                new CustomEvent("toggle-activity-panel")
                            );
                        }}
                        aria-expanded={isActivityPanelOpen}
                        aria-controls="activity-panel-mobile"
                        className="w-11 h-11 flex items-center justify-center text-[var(--text-secondary)] hover:text-white transition-colors duration-200 ml-2 flex-shrink-0 relative"
                        aria-label="Notifications"
                        title="notifications"
                    >
                        <Bell className="w-5 h-5" />
                    </button>
                </>
            ) : (
                <>
                    <div className="w-72 flex items-center px-2">
                        <Link
                            href="/"
                            className="flex items-center gap-2 group"
                        >
                            <KimaMark size={32} className="group-hover:scale-105 transition-transform" />
                        </Link>
                        <button
                            type="button"
                            onClick={() => void openWhatsNewOrChangelog(user?.id, (href) => router.push(href))}
                            aria-label={chip.label}
                            title={chip.title}
                            className="relative ml-2 px-1.5 py-0.5 text-micro font-medium text-brand/80 bg-brand/[0.06] rounded border border-brand/25 transition-colors hover:text-brand hover:bg-brand/10 hover:border-brand/50 focus-visible:outline-2 focus-visible:outline-brand"
                        >
                            v{APP_VERSION}
                            {chip.openCount > 0 && <span className="ml-1 text-brand">· {chip.openCount} open</span>}
                            {chip.update && (
                                <span
                                    aria-hidden
                                    className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-warning ring-2 ring-[var(--bg-primary)]"
                                />
                            )}
                        </button>
                    </div>

                    {/* Center - Home & Search */}
                    <div className="flex-1 flex items-center justify-center gap-3 max-w-3xl mx-auto">
                        <Link
                            href="/"
                            className={cn(
                                "w-12 h-12 rounded-full flex items-center justify-center transition-all duration-200 flex-shrink-0",
                                pathname === "/"
                                    ? "bg-white text-black"
                                    : "bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-white hover:scale-105"
                            )}
                            aria-label="Home"
                            title="home"
                        >
                            <Home className="w-6 h-6" />
                        </Link>

                        <form
                            onSubmit={handleSearch}
                            className="flex-1 max-w-md"
                        >
                            <div
                                className="relative"
                                data-tv-section="search-input"
                            >
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--text-secondary)]" />
                                <input
                                    ref={searchInputRef}
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) =>
                                        setSearchQuery(e.target.value)
                                    }
                                    placeholder="What do you want to play?"
                                    aria-label="Search"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    tabIndex={0}
                                    className="w-full h-12 pl-12 pr-4 bg-[var(--bg-hover)] hover:bg-[#242424] border-2 border-transparent focus:border-white/20 rounded-full text-sm text-white placeholder-gray-400 transition-all duration-200 outline-none"
                                />
                            </div>
                        </form>
                    </div>

                    {/* Right - Sync & Settings */}
                    <div className="w-72 flex items-center justify-end gap-2 px-2">
                        <button
                            onClick={handleSync}
                            disabled={isPolling}
                            aria-label={
                                isPolling
                                    ? "Library scan in progress"
                                    : hasActiveDownloads
                                    ? `${downloadStatus.activeDownloads.length} download(s) in progress`
                                    : hasPendingUploads
                                    ? `${pendingDownloads.length} download(s) starting`
                                    : "Sync library"
                            }
                            className={cn(
                                "flex items-center gap-2 px-3 h-11 rounded-full transition-all duration-200 text-sm font-medium",
                                isPolling
                                    ? "bg-white/10 text-[var(--text-muted)] cursor-not-allowed"
                                    : hasActiveDownloads
                                    ? "text-brand"
                                    : "bg-[var(--bg-primary)] text-white hover:bg-white/20"
                            )}
                            title={
                                isPolling
                                    ? "library scan in progress..."
                                    : hasActiveDownloads
                                    ? `${downloadStatus.activeDownloads.length} download(s) in progress`.toLowerCase()
                                    : hasPendingUploads
                                    ? `${pendingDownloads.length} download(s) starting...`.toLowerCase()
                                    : "sync library"
                            }
                        >
                            <RefreshCw
                                className={cn(
                                    "w-4 h-4",
                                    (isPolling || hasActiveDownloads) &&
                                        "animate-spin"
                                )}
                            />
                        </button>
                        <ActivityPanelToggle />
                        <Link
                            href="/settings"
                            className={cn(
                                "w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200",
                                pathname === "/settings"
                                    ? "bg-white text-black"
                                    : "text-[var(--text-secondary)] hover:text-white"
                            )}
                            aria-label="Settings"
                            title="settings"
                        >
                            <Settings className="w-5 h-5" />
                        </Link>
                        <button
                            onClick={handleLogout}
                            className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 text-danger-light hover:brightness-125"
                            aria-label="Logout"
                            title="logout"
                        >
                            <Power className="w-5 h-5" />
                        </button>
                    </div>
                </>
            )}
        </header>
    );
}
