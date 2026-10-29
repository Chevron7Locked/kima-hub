"use client";

import type { ReactNode } from "react";
import { X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** A tool's floating panel over the vibe map: a titled header with a close button, then a body that scrolls. */
export function ScenePanel({
    icon: Icon,
    title,
    closeLabel,
    onClose,
    className,
    children,
}: {
    icon: LucideIcon;
    title: string;
    closeLabel: string;
    onClose: () => void;
    /** The panel's width from the small breakpoint up. */
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                "absolute top-16 left-1/2 -translate-x-1/2 z-(--z-scene-panel) w-[calc(100%-1.5rem)] max-h-[min(70vh,calc(100%-5rem))] border border-white/10 bg-[rgb(12,8,20)] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.7)] rounded-2xl flex flex-col overflow-hidden",
                className,
            )}
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h3 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                    <Icon className="w-4 h-4" /> {title}
                </h3>
                <button type="button" onClick={onClose} className="text-[var(--text-muted)] hover:text-white" aria-label={closeLabel}>
                    <X className="w-4 h-4" />
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        </div>
    );
}
