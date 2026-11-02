"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Settings, RefreshCw, LogOut, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth-context";
import { notify } from "@/lib/notify";
import { KimaMark } from "@/components/ui/KimaMark";
import { APP_VERSION } from "@/lib/version";
import { openWhatsNewOrChangelog } from "@/components/whats-new/WhatsNewGate";
import { useVersionChip } from "@/components/whats-new/useVersionChip";
import { useLibrarySync } from "@/hooks/useLibrarySync";
import { NAV, isCurrentNav } from "./navItems";

/** What the phone menu adds to the tab bar's destinations. */
const QUICK_LINKS = [NAV.discover, NAV.radio, NAV.releases, NAV.stats];

const linkClass = (current: boolean) =>
    cn(
        "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-200",
        current ? "bg-white/10 text-white" : "text-[var(--text-secondary)] hover:text-white hover:bg-white/5",
    );

interface MobileSidebarProps {
    isOpen: boolean;
    onClose: () => void;
}

export function MobileSidebar({ isOpen, onClose }: MobileSidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const { logout, user } = useAuth();
    const chip = useVersionChip();
    const { sync, syncing: isSyncing } = useLibrarySync();
    const isFirstRender = useRef(true);

    // Close on route change (skip initial mount)
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        onClose();
    }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSync = async () => {
        if (await sync()) onClose();
    };

    const handleLogout = async () => {
        try {
            await logout();
            onClose();
        } catch {
            notify.error("couldn't log out");
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
                            kima
                        </span>
                    </Link>
                    <button
                        onClick={onClose}
                        className="w-9 h-9 flex items-center justify-center text-[var(--text-muted)] hover:text-white transition-colors duration-200 rounded-full hover:bg-white/10"
                        aria-label="close menu"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <nav
                    className="flex-1 overflow-y-auto py-4"
                    role="navigation"
                    aria-label="menu"
                >
                    <div className="px-3 mb-6">
                        <div className="text-xs font-semibold text-[var(--text-muted)] px-3 mb-2">
                            quick links
                        </div>

                        {QUICK_LINKS.map((item) => {
                            const current = isCurrentNav(item, pathname);
                            return (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    aria-current={current ? "page" : undefined}
                                    className={linkClass(current)}
                                >
                                    <item.icon className="w-5 h-5" />
                                    <span className="text-sm font-medium">{item.name}</span>
                                </Link>
                            );
                        })}
                    </div>

                    <div className="px-3">
                        <div className="text-xs font-semibold text-[var(--text-muted)] px-3 mb-2">
                            actions
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
                                {isSyncing ? "syncing..." : "sync library"}
                            </span>
                        </button>

                        <Link
                            href="/settings"
                            aria-current={pathname.startsWith("/settings") ? "page" : undefined}
                            className={linkClass(pathname.startsWith("/settings"))}
                        >
                            <Settings className="w-5 h-5" />
                            <span className="text-sm font-medium">
                                settings
                            </span>
                        </Link>
                    </div>
                </nav>

                <div className="border-t border-white/[0.06] p-3">
                    <button
                        type="button"
                        onClick={() => {
                            onClose();
                            void openWhatsNewOrChangelog(user?.id, (href) => router.push(href));
                        }}
                        aria-label={chip.label}
                        title={chip.title}
                        className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-colors duration-200"
                    >
                        <span className="relative text-sm">
                            What&apos;s new in <span className="text-brand/80">v{APP_VERSION}</span>
                            {chip.openCount > 0 && <span className="ml-1 text-brand/80">· {chip.openCount} open</span>}
                            {chip.update && (
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
                        <span className="text-sm font-medium">log out</span>
                    </button>
                </div>
            </div>
        </>
    );
}
