"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef, type FormEvent, type Ref } from "react";
import { Home, Search, Settings, RefreshCw, Power, Menu } from "lucide-react";
import { ActivityPanelToggle } from "./ActivityPanel";
import { cn } from "@/lib/cn";
import { notify } from "@/lib/notify";
import { useDownloadContext } from "@/lib/download-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useLibrarySync } from "@/hooks/useLibrarySync";
import { useAuth } from "@/lib/auth-context";
import { APP_VERSION } from "@/lib/version";
import { openWhatsNewOrChangelog } from "@/components/whats-new/WhatsNewGate";
import { useVersionChip } from "@/components/whats-new/useVersionChip";
import { KimaMark } from "@/components/ui/KimaMark";

/** The top bar's search field: full size on desktop, compact beside the phone's menu and home buttons. */
function SearchField({
    value,
    onChange,
    onSubmit,
    compact,
    inputRef,
}: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (e: FormEvent<HTMLFormElement>) => void;
    compact: boolean;
    inputRef?: Ref<HTMLInputElement>;
}) {
    return (
        <form onSubmit={onSubmit} className={compact ? "flex-1 min-w-0" : "flex-1 max-w-md"}>
            <div className="relative" data-tv-section="search-input">
                <Search
                    className={cn(
                        "absolute top-1/2 -translate-y-1/2 text-[var(--text-secondary)]",
                        compact ? "left-3 w-4 h-4" : "left-4 w-5 h-5"
                    )}
                />
                <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={compact ? "search..." : "what do you want to play?"}
                    aria-label="Search"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className={cn(
                        "w-full bg-[var(--bg-hover)] hover:bg-[#242424] border-2 border-transparent focus:border-white/20 rounded-full text-sm text-white placeholder-gray-400 transition-all duration-200 outline-none",
                        compact ? "h-11 pl-10 pr-3" : "h-12 pl-12 pr-4"
                    )}
                />
            </div>
        </form>
    );
}

export function TopBar() {
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { logout, user } = useAuth();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [searchQuery, setSearchQuery] = useState("");
    const chip = useVersionChip();
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const { sync: handleSync, syncing } = useLibrarySync();

    // The icon spins for downloads the server reports; pendingDownloads is optimistic local state that can go stale.
    const { pendingDownloads, downloadStatus } = useDownloadContext();
    const hasActiveDownloads = downloadStatus.hasActiveDownloads;

    // Only downloads asked for in the last 30 s count as starting; `now` advances when the oldest one ages out.
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

    const handleLogout = async () => {
        try {
            await logout();
        } catch {
            notify.error("couldn't log out");
        }
    };

    const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (searchQuery.trim()) {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }
    };

    // Typing searches once it pauses for 500 ms, unless the search page already shows this query.
    useEffect(() => {
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

        searchTimeoutRef.current = setTimeout(() => {
            router.push(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
        }, 500);

        return () => {
            if (searchTimeoutRef.current) {
                clearTimeout(searchTimeoutRef.current);
            }
        };
    }, [searchQuery, router, pathname]);

    // The field follows the URL: the search page's query, empty anywhere else.
    const [syncedPathname, setSyncedPathname] = useState<string | null>(null);
    if (pathname !== syncedPathname) {
        setSyncedPathname(pathname);
        const q = searchParams.get("q");

        if (pathname === "/search" && q) {
            if (q !== searchQuery) {
                setSearchQuery(q);
            }
        } else if (pathname !== "/search" && searchQuery) {
            setSearchQuery("");
        }
    }

    // "/" anywhere outside a text field focuses the search.
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
            {/* Phone and tablet: menu, home, search and activity. */}
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

                    <SearchField value={searchQuery} onChange={setSearchQuery} onSubmit={handleSearch} compact />

                    <ActivityPanelToggle />
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

                        <SearchField
                            value={searchQuery}
                            onChange={setSearchQuery}
                            onSubmit={handleSearch}
                            compact={false}
                            inputRef={searchInputRef}
                        />
                    </div>

                    <div className="w-72 flex items-center justify-end gap-2 px-2">
                        <button
                            onClick={handleSync}
                            disabled={syncing}
                            aria-label={
                                syncing
                                    ? "Library scan in progress"
                                    : hasActiveDownloads
                                    ? `${downloadStatus.activeDownloads.length} download(s) in progress`
                                    : hasPendingUploads
                                    ? `${pendingDownloads.length} download(s) starting`
                                    : "Sync library"
                            }
                            className={cn(
                                "flex items-center gap-2 px-3 h-11 rounded-full transition-all duration-200 text-sm font-medium",
                                syncing
                                    ? "bg-white/10 text-[var(--text-muted)] cursor-not-allowed"
                                    : hasActiveDownloads
                                    ? "text-brand"
                                    : "bg-[var(--bg-primary)] text-white hover:bg-white/20"
                            )}
                            title={
                                syncing
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
                                    (syncing || hasActiveDownloads) &&
                                        "animate-spin"
                                )}
                            />
                        </button>
                        <ActivityPanelToggle />
                        <Link
                            href="/settings"
                            className={cn(
                                "w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200",
                                pathname.startsWith("/settings")
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
