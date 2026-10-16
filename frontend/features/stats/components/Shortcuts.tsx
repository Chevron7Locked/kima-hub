"use client";

/**
 * Keyboard shortcuts: digits open chapters in tab order, ? lists them. A
 * corner panel rather than a dialog, so it neither covers the page nor steals
 * focus.
 */

import { useEffect, useState } from "react";
import { X } from "lucide-react";

/** Typing somewhere? Then a bare letter is text, not a command. */
function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function Shortcuts({
    chapters,
    onJump,
}: {
    chapters: Array<{ id: string; label: string }>;
    onJump: (index: number) => void;
}) {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "?") { e.preventDefault(); setOpen((v) => !v); return; }
            if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); return; }
            const n = Number(e.key);
            if (Number.isInteger(n) && n >= 1 && n <= chapters.length) {
                e.preventDefault();
                onJump(n - 1);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [chapters, onJump, open]);

    const hint = (
        <p className="t-meta hidden shrink-0 lg:block">
            press <kbd className="t-data px-1 py-0.5 rounded bg-white/[0.08] text-[var(--text-secondary)]">?</kbd> for shortcuts
        </p>
    );
    if (!open) return hint;

    return (
        <>
        {hint}
        <div
            role="dialog"
            aria-label="keyboard shortcuts"
            className="hidden sm:flex fixed bottom-24 right-6 z-(--z-dropdown) w-[19rem] flex-col gap-4 rounded-xl border border-white/10 bg-[var(--bg-secondary)] p-5 animate-rise"
        >
            <div className="flex items-baseline justify-between gap-4">
                <h2 className="t-label text-[var(--text-secondary)]">keyboard shortcuts</h2>
                <button
                    onClick={() => setOpen(false)}
                    aria-label="close"
                    className="-mr-1 -mt-1 w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <dl className="flex flex-col gap-2">
                {chapters.map((c, i) => (
                    <div key={c.id} className="flex items-baseline justify-between gap-4">
                        <dt className="t-meta text-[var(--text-secondary)]">{c.label}</dt>
                        <dd><Key>{i + 1}</Key></dd>
                    </div>
                ))}
            </dl>

            <div className="flex flex-col gap-2 border-t border-white/[0.08] pt-4">
                <div className="flex items-baseline justify-between gap-4">
                    <span className="t-meta text-[var(--text-secondary)]">move in the hour grid</span>
                    <span className="flex gap-1"><Key>←</Key><Key>→</Key><Key>↑</Key><Key>↓</Key></span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                    <span className="t-meta text-[var(--text-secondary)]">open an hour</span>
                    <Key>enter</Key>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                    <span className="t-meta text-[var(--text-secondary)]">close</span>
                    <Key>esc</Key>
                </div>
            </div>
        </div>
        </>
    );
}

function Key({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="t-data px-1.5 py-0.5 rounded bg-white/[0.08] text-[var(--text-secondary)] leading-none">
            {children}
        </kbd>
    );
}
