"use client";

import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/** One answer to a What's new question: brand-filled with a tick once chosen, a spinner while the answer is sent. */
export function ChoiceButton({
    label,
    selected,
    onClick,
    busy = false,
    disabled = false,
    testId,
}: {
    label: string;
    selected: boolean;
    onClick: () => void;
    busy?: boolean;
    disabled?: boolean;
    testId?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={selected}
            data-testid={testId}
            className={cn(
                "h-11 px-4 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-60",
                selected
                    ? "bg-brand text-black"
                    : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.08]",
            )}
        >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : selected ? <Check className="w-4 h-4" /> : null}
            {label}
        </button>
    );
}
