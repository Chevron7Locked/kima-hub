"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
    Settings,
    RefreshCw,
    LogOut,
    Compass,
    X,
    Radio,
    Calendar,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import Image from "next/image";

interface MobileSidebarProps {
    isOpen: boolean;
    onClose: () => void;
}

export function MobileSidebar({ isOpen, onClose }: MobileSidebarProps) {
    const pathname = usePathname();
    const { logout } = useAuth();
    const { toast } = useToast();
    const [isSyncing, setIsSyncing] = useState(false);

    // Close on route change
    useEffect(() => {
        onClose();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]);

    // Handle library sync
    const handleSync = async () => {
        if (isSyncing) return;

        try {
            setIsSyncing(true);
            await api.scanLibrary();
            window.dispatchEvent(new CustomEvent("notifications-changed"));
            onClose();
        } catch (error) {
            console.error("Failed to sync library:", error);
            toast.error("Failed to start scan. Please try again.");
        } finally {
            setTimeout(() => setIsSyncing(false), 2000);
        }
    };

    // Handle logout
    const handleLogout = async () => {
        try {
            await logout();
            toast.success("Logged out successfully");
            onClose();
        } catch (error) {
            console.error("Logout error:", error);
            toast.error("Failed to logout");
        }
    };

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/60  z-50 transition-opacity"
                onClick={onClose}
                aria-hidden="true"
            />

            {/* Sidebar Drawer */}
            <div
                className="fixed inset-y-0 left-0 w-[280px] bg-[#0a0a0a] z-50 flex flex-col overflow-hidden transform transition-transform border-r border-white/[0.06]"
                style={{
                    paddingTop: "env(safe-area-inset-top)",
                }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                    <Link
                        href="/"
                        className="flex items-center gap-3"
                        onClick={onClose}
                    >
                        <Image
                            src="/assets/images/LIDIFY.webp"
                            alt="Lidify"
                            width={32}
                            height={32}
                            className="flex-shrink-0"
                        />
                        <span className="text-lg font-bold text-white tracking-tight">
                            Lidify
                        </span>
                    </Link>
                    <button
                        onClick={onClose}
                        className="w-9 h-9 flex items-center justify-center text-gray-500 hover:text-white transition-colors rounded-full hover:bg-white/10"
                        aria-label="Close menu"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Menu Content */}
                <nav className="flex-1 overflow-y-auto py-4" role="navigation" aria-label="Mobile menu">
                    {/* Quick Links Section */}
                    <div className="px-3 mb-6">
                        <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest px-3 mb-2">
                            Quick Links
                        </div>

                        <Link
                            href="/discover"
                            aria-current={pathname === "/discover" ? "page" : undefined}
                            aria-label="Discover"
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors",
                                pathname === "/discover"
                                    ? "bg-white/10 text-white"
                                    : "text-gray-400 hover:text-white hover:bg-white/5"
                            )}
                        >
                            <Compass className="w-5 h-5" />
                            <span className="text-[15px] font-medium">
                                Discover
                            </span>
                        </Link>

                        <Link
                            href="/radio"
                            aria-current={pathname === "/radio" ? "page" : undefined}
                            aria-label="Radio"
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors",
                                pathname === "/radio"
                                    ? "bg-white/10 text-white"
                                    : "text-gray-400 hover:text-white hover:bg-white/5"
                            )}
                        >
                            <Radio className="w-5 h-5" />
                            <span className="text-[15px] font-medium">
                                Radio
                            </span>
                        </Link>

                        <Link
                            href="/releases"
                            aria-current={pathname === "/releases" ? "page" : undefined}
                            aria-label="Releases"
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors",
                                pathname === "/releases"
                                    ? "bg-white/10 text-white"
                                    : "text-gray-400 hover:text-white hover:bg-white/5"
                            )}
                        >
                            <Calendar className="w-5 h-5" />
                            <span className="text-[15px] font-medium">
                                Releases
                            </span>
                        </Link>
                    </div>

                    {/* Actions Section */}
                    <div className="px-3">
                        <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest px-3 mb-2">
                            Actions
                        </div>

                        <button
                            onClick={handleSync}
                            disabled={isSyncing}
                            className={cn(
                                "w-full flex items-center gap-3 px-3 py-3 rounded-lg transition-colors text-left",
                                isSyncing
                                    ? "text-green-400"
                                    : "text-gray-400 hover:text-white hover:bg-white/5"
                            )}
                        >
                            <RefreshCw
                                className={cn(
                                    "w-5 h-5",
                                    isSyncing && "animate-spin"
                                )}
                            />
                            <span className="text-[15px] font-medium">
                                {isSyncing ? "Syncing..." : "Sync Library"}
                            </span>
                        </button>

                        <Link
                            href="/settings"
                            aria-current={pathname === "/settings" ? "page" : undefined}
                            className={cn(
                                "flex items-center gap-3 px-3 py-3 rounded-lg transition-colors",
                                pathname === "/settings"
                                    ? "bg-white/10 text-white"
                                    : "text-gray-400 hover:text-white hover:bg-white/5"
                            )}
                        >
                            <Settings className="w-5 h-5" />
                            <span className="text-[15px] font-medium">
                                Settings
                            </span>
                        </Link>
                    </div>
                </nav>

                {/* Footer - Logout */}
                <div className="border-t border-white/[0.06] p-3">
                    <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                    >
                        <LogOut className="w-5 h-5" />
                        <span className="text-[15px] font-medium">Logout</span>
                    </button>
                </div>
            </div>
        </>
    );
}
