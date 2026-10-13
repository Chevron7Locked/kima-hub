"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Settings, RefreshCw, LogOut, Compass, X, Radio, ChartNoAxesColumn } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { notify } from "@/lib/notify";
import { KimaMark } from "@/components/ui/KimaMark";
import { APP_VERSION } from "@/lib/version";
import { useUpdateStatus } from "@/hooks/useUpdateStatus";
import { openWhatsNewOrChangelog, fetchOpenCount } from "@/components/whats-new/WhatsNewGate";

interface MobileSidebarProps {
    isOpen: boolean;
    onClose: () => void;
}

export function MobileSidebar({ isOpen, onClose }: MobileSidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const { logout } = useAuth();
    const updateStatus = useUpdateStatus();
    const [openCount, setOpenCount] = useState(0);

    useEffect(() => {
        void fetchOpenCount().then(setOpenCount);
    }, []);
    const [isSyncing, setIsSyncing] = useState(false);
    const isFirstRender = useRef(true);
    const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Close on route change (skip initial mount)
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        onClose();
    }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        return () => {
            if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
        };
    }, []);

    const handleSync = async () => {
        if (isSyncing) return;

        try {
            setIsSyncing(true);
            await api.scanLibrary();
            onClose();
        } catch {
            notify.error("Could not start the library scan");
        } finally {
            syncTimeoutRef.current = setTimeout(() => setIsSyncing(false), 2000);
        }
    };

    const handleLogout = async () => {
        try {
            await logout();
            onClose();
        } catch {
            notify.error("Failed to logout");
        }
    };

    if (!isOpen) return null;

    return (
        <>
            <div
                className="fixed inset-0 bg-black/60 z-(--z-drawer-backdrop) transition-opacity duration-200"
                onClick={onClose}
                aria-hidden="true"
            />

            <div
                className="fixed inset-y-0 left-0 w-[280px] bg-[var(--bg-primary)] z-(--z-drawer) flex flex-col overflow-hidden transform transition-transform duration-300 border-r border-white/[0.06]"
                style={{
                    paddingTop: "var(--standalone-safe-area-top, 0px)",
                }}
            >
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                    <Link
                        href="/"
                        className="flex items-center gap-3"
                        onClick={onClose}
                    >
                        <KimaMark size={32} />
                        <span className="text-lg font-bold text-white tracking-tight">
                            Kima
                        </span>
                    </Link>
                    <button
                        onClick={onClose}
                className="w-9 h-9 flex items-center justify-center text-[var(--text-muted)] hover:text-white transition-colors duration-200 rounded-full hover:bg-white/10"
                        aria-label="Close menu"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <nav
                    className="flex-1 overflow-y-auto py-4"
                    role="navigation"
                    aria-label="Mobile menu"
                >
                    <div className="px-3 mb-6">
                        <div className="text-xs font-semibold text-[var(--text-muted)] px-3 mb-2">
                            Quick Links
                        </div>

                        <Link
                            href="/discover"
                            aria-current={
                                pathname === "/discover" ? "page" : undefined
                            }
                            aria-label="Discover"
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-200",
                                pathname === "/discover" ?
                                    "bg-white/10 text-white"
                                :   "text-[var(--text-secondary)] hover:text-white hover:bg-white/5",
                            )}
                        >
                            <Compass className="w-5 h-5" />
                            <span className="text-sm font-medium">
                                Discover
                            </span>
                        </Link>

                        <Link
                            href="/radio"
                            aria-current={
                                pathname === "/radio" ? "page" : undefined
                            }
                            aria-label="Radio"
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-200",
                                pathname === "/radio" ?
                                    "bg-white/10 text-white"
                                :   "text-[var(--text-secondary)] hover:text-white hover:bg-white/5",
                            )}
                        >
                            <Radio className="w-5 h-5" />
                            <span className="text-sm font-medium">
                                Radio
                            </span>
                        </Link>

                        <Link
                            href="/stats"
                            aria-current={
                                pathname === "/stats" ? "page" : undefined
                            }
                            aria-label="Stats"
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-200",
                                pathname === "/stats" ?
                                    "bg-white/10 text-white"
                                :   "text-[var(--text-secondary)] hover:text-white hover:bg-white/5",
                            )}
                        >
                            <ChartNoAxesColumn className="w-5 h-5" />
                            <span className="text-sm font-medium">
                                Stats
                            </span>
                        </Link>
                    </div>

                    <div className="px-3">
                        <div className="text-xs font-semibold text-[var(--text-muted)] px-3 mb-2">
                            Actions
                        </div>

                        <button
                            onClick={handleSync}
                            disabled={isSyncing}
                            className={cn(
                                "w-full flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-200 text-left",
                                isSyncing ? "text-brand" : (
                                    "text-[var(--text-secondary)] hover:text-white hover:bg-white/5"
                                ),
                            )}
                        >
                            <RefreshCw
                                className={cn(
                                    "w-5 h-5",
                                    isSyncing && "animate-spin",
                                )}
                            />
                            <span className="text-sm font-medium">
                                {isSyncing ? "Syncing..." : "Sync Library"}
                            </span>
                        </button>

                        <Link
                            href="/settings"
                            aria-current={
                                pathname === "/settings" ? "page" : undefined
                            }
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-200",
                                pathname === "/settings" ?
                                    "bg-white/10 text-white"
                                :   "text-[var(--text-secondary)] hover:text-white hover:bg-white/5",
                            )}
                        >
                            <Settings className="w-5 h-5" />
                            <span className="text-sm font-medium">
                                Settings
                            </span>
                        </Link>
                    </div>
                </nav>

                <div className="border-t border-white/[0.06] p-3">
                    <button
                        type="button"
                        onClick={() => {
                            onClose();
                            void openWhatsNewOrChangelog((href) => router.push(href));
                        }}
                        aria-label={`what's new in v${APP_VERSION}${openCount > 0 ? ` — ${openCount} open` : ""}`}
                        title={updateStatus?.hasUpdate && updateStatus.latest ? `update available: v${updateStatus.latest}` : `what's new in v${APP_VERSION}`}
                        className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-colors duration-200"
                    >
                        <span className="relative text-sm">
                            What&apos;s new in <span className="text-brand/80">v{APP_VERSION}</span>
                            {openCount > 0 && <span className="ml-1 text-brand/80">· {openCount} open</span>}
                            {updateStatus?.hasUpdate && updateStatus.latest && (
                                <span
                                    aria-hidden
                                    className="absolute -top-1 -right-3 w-2 h-2 rounded-full bg-warning"
                                />
                            )}
                        </span>
                    </button>
                    <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-danger-light hover:brightness-125 hover:bg-danger/10 transition-colors duration-200"
                    >
                        <LogOut className="w-5 h-5" />
                        <span className="text-sm font-medium">Logout</span>
                    </button>
                </div>
            </div>
        </>
    );
}
