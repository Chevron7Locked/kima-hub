"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import { Home, Search, Settings, RefreshCw, Power, Menu, Bell } from "lucide-react";
import { ActivityPanelToggle } from "./ActivityPanel";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { useJobStatus } from "@/hooks/useJobStatus";
import { useDownloadContext } from "@/lib/download-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { useAuth } from "@/lib/auth-context";
import { useQueryClient } from "@tanstack/react-query";
import Image from "next/image";

export function TopBar() {
    const pathname = usePathname();
    const router = useRouter();
    const { logout } = useAuth();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [searchQuery, setSearchQuery] = useState("");
    const [scanJobId, setScanJobId] = useState<string | null>(null);
    const [lastScanTime, setLastScanTime] = useState<number>(0);
    const { toast } = useToast();
    const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const queryClient = useQueryClient();

    const { jobStatus, isPolling } = useJobStatus(scanJobId, "scan", {
        onComplete: () => {
            // Refresh Activity Panel and enrichment progress after scan
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
            queryClient.invalidateQueries({ queryKey: ["enrichment-progress"] });
            setScanJobId(null);
        },
        onError: () => {
            // Scan errors will show in the activity panel via notifications
            setScanJobId(null);
        },
    });

    // Track download status from context (single source of truth)
    const { pendingDownloads, downloadStatus } = useDownloadContext();
    // Only use API-driven state for the icon
    // pendingDownloads is optimistic local state that can become stale
    const hasActiveDownloads = downloadStatus.hasActiveDownloads;
    const hasPendingUploads = pendingDownloads.length > 0 &&
        pendingDownloads.some(p => Date.now() - p.timestamp < 30000); // Only count recent pending
    const hasFailedDownloads = downloadStatus.failedDownloads.length > 0;

    const handleSync = async () => {
        if (isPolling) return;

        // Prevent spam clicking - cooldown of 5 seconds (silently ignore)
        const now = Date.now();
        const timeSinceLastScan = now - lastScanTime;
        if (timeSinceLastScan < 5000) {
            return;
        }

        try {
            setLastScanTime(now);
            const response = await api.scanLibrary();
            setScanJobId(response.jobId);
            // Refresh notifications to show the scan started notification
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
        } catch (error) {
            console.error("Failed to trigger library scan:", error);
            // Scan errors will show in the activity panel via notifications
        }
    };

    const handleLogout = async () => {
        try {
            await logout();
            toast.success("Logged out successfully");
        } catch (error) {
            console.error("Logout error:", error);
            toast.error("Failed to logout");
        }
    };

    const handleSearch = (e: React.FormEvent) => {
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

        // Clear any existing timeout
        if (searchTimeoutRef.current) {
            clearTimeout(searchTimeoutRef.current);
        }

        // Don't search if query is empty
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
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const q = params.get("q");

        if (pathname === "/search" && q) {
            // Only update if different to avoid loops
            if (q !== searchQuery) {
                setSearchQuery(q);
            }
        } else if (pathname !== "/search" && searchQuery) {
            // Clear search when leaving search page
            setSearchQuery("");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]); // Only re-run when pathname changes

    return (
        <header
            className="fixed top-0 left-0 right-0 bg-black flex items-center px-3 z-50"
            style={{ height: isMobileOrTablet ? "58px" : "64px" }}
        >
            {/* Mobile/Tablet Layout: Hamburger + Home + Search + Bell */}
            {isMobileOrTablet ? (
                <>
                    {/* Hamburger menu button */}
                    <button
                        onClick={() => {
                            // Dispatch custom event to toggle mobile menu
                            window.dispatchEvent(
                                new CustomEvent("toggle-mobile-menu")
                            );
                        }}
                        className="w-10 h-10 flex items-center justify-center bg-[#0f0f0f] border border-[#262626] rounded-md text-white hover:bg-[#141414] transition-colors mr-2 flex-shrink-0"
                        aria-label="Open menu"
                    >
                        <Menu className="w-5 h-5" />
                    </button>

                    {/* Home */}
                    <Link
                        href="/"
                        className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center transition-all flex-shrink-0 mr-2",
                            pathname === "/"
                                ? "bg-white text-black"
                                : "bg-[#0a0a0a] text-gray-400 hover:bg-[#1a1a1a] hover:text-white"
                        )}
                        aria-label="Home"
                        title="Home"
                    >
                        <Home className="w-5 h-5" />
                    </Link>

                    {/* Search */}
                    <form onSubmit={handleSearch} className="flex-1 min-w-0">
                        <div
                            className="relative"
                            data-tv-section="search-input"
                        >
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) =>
                                    setSearchQuery(e.target.value)
                                }
                                placeholder="Search..."
                                aria-label="Search"
                                autoCapitalize="none"
                                autoCorrect="off"
                                tabIndex={0}
                                className="w-full h-10 pl-10 pr-3 bg-[#1a1a1a] hover:bg-[#242424] border-2 border-transparent focus:border-white/20 rounded-full text-sm text-white placeholder-gray-400 transition-all outline-none"
                            />
                        </div>
                    </form>

                    {/* Notification Bell */}
                    <button
                        onClick={() => {
                            window.dispatchEvent(
                                new CustomEvent("toggle-activity-panel")
                            );
                        }}
                        className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-white transition-colors ml-2 flex-shrink-0 relative"
                        aria-label="Notifications"
                        title="Notifications"
                    >
                        <Bell className="w-5 h-5" />
                        {/* TODO: Add notification badge in Phase 3 */}
                    </button>
                </>
            ) : (
                <>
                    {/* Desktop Layout */}
                    {/* Logo - Far Left */}
                    <div className="w-72 flex items-center px-2">
                        <Link
                            href="/"
                            className="flex items-center gap-2 group"
                        >
                            <Image
                                src="/assets/images/LIDIFY.webp"
                                alt="Lidify"
                                width={32}
                                height={32}
                                className="group-hover:scale-105 transition-transform"
                            />
                            <span className="text-xl font-semibold text-white">
                                Lidify
                            </span>
                        </Link>
                    </div>

                    {/* Center - Home & Search */}
                    <div className="flex-1 flex items-center justify-center gap-3 max-w-3xl mx-auto">
                        <Link
                            href="/"
                            className={cn(
                                "w-12 h-12 rounded-full flex items-center justify-center transition-all flex-shrink-0",
                                pathname === "/"
                                    ? "bg-white text-black"
                                    : "bg-[#0a0a0a] text-gray-400 hover:bg-[#1a1a1a] hover:text-white hover:scale-105"
                            )}
                            aria-label="Home"
                            title="Home"
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
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                <input
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
                                    className="w-full h-12 pl-12 pr-4 bg-[#1a1a1a] hover:bg-[#242424] border-2 border-transparent focus:border-white/20 rounded-full text-sm text-white placeholder-gray-400 transition-all outline-none"
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
                                    : hasFailedDownloads
                                    ? `${downloadStatus.failedDownloads.length} download(s) failed`
                                    : "Sync library"
                            }
                            className={cn(
                                "flex items-center gap-2 px-3 h-10 rounded-full transition-all text-sm font-medium",
                                isPolling
                                    ? "bg-white/10 text-gray-500 cursor-not-allowed"
                                    : hasActiveDownloads
                                    ? " text-green-400 "
                                    : hasFailedDownloads
                                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                                    : "bg-#0a0a0a text-white hover:bg-white/20"
                            )}
                            title={
                                isPolling
                                    ? "Library scan in progress..."
                                    : hasActiveDownloads
                                    ? `${downloadStatus.activeDownloads.length} download(s) in progress`
                                    : hasPendingUploads
                                    ? `${pendingDownloads.length} download(s) starting...`
                                    : hasFailedDownloads
                                    ? `${downloadStatus.failedDownloads.length} download(s) failed`
                                    : "Sync Library"
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
                                "w-10 h-10 rounded-full flex items-center justify-center transition-all",
                                pathname === "/settings"
                                    ? "bg-white text-black"
                                    : "text-white/60 hover:text-white"
                            )}
                            aria-label="Settings"
                            title="Settings"
                        >
                            <Settings className="w-5 h-5" />
                        </Link>
                        <button
                            onClick={handleLogout}
                            className="w-10 h-10 rounded-full flex items-center justify-center transition-all text-red-400 hover:text-red-300"
                            aria-label="Logout"
                            title="Logout"
                        >
                            <Power className="w-5 h-5" />
                        </button>
                    </div>
                </>
            )}
        </header>
    );
}
