"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The quiet row above an activity list: what it holds, and one action on all of it (clear all, cancel all). */
export function ListHeader({
    children,
    action,
}: {
    children?: ReactNode;
    action?: { label: string; onClick: () => void; danger?: boolean };
}) {
    return (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3 text-xs tabular-nums text-[var(--text-muted)]">
            <span className="flex min-w-0 items-center gap-2 truncate">{children}</span>
            {action && (
                <button
                    type="button"
                    onClick={action.onClick}
                    className={cn(
                        "shrink-0 rounded-md px-1.5 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/60",
                        action.danger ? "hover:text-danger-light" : "hover:text-[var(--text-primary)]",
                    )}
                >
                    {action.label}
                </button>
            )}
        </div>
    );
}
