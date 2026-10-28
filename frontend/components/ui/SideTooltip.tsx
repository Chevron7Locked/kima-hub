"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const HOVER_DELAY_MS = 350;

/**
 * A name shown to the right of an icon-only control, on hover (after a short pause) and on keyboard focus. It is drawn
 * in a portal, so a parent that clips its overflow (the sidebar) cannot cut it off. It measures from a flex box around
 * the control. The control keeps its own accessible name; the tooltip is for the eye only.
 */
export function SideTooltip({ label, children }: { label: string; children: ReactNode }) {
    const anchor = useRef<HTMLElement | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

    const show = useCallback(() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (rect) setPlace({ top: rect.top + rect.height / 2, left: rect.right + 10 });
    }, []);
    const hide = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setPlace(null);
    }, []);

    // The anchor moves with scrolling and resizing; the tooltip simply goes rather than following it.
    useEffect(() => {
        if (!place) return;
        window.addEventListener("scroll", hide, true);
        window.addEventListener("resize", hide);
        return () => {
            window.removeEventListener("scroll", hide, true);
            window.removeEventListener("resize", hide);
        };
    }, [place, hide]);
    useEffect(() => hide, [hide]);

    return (
        <>
            <span
                ref={anchor}
                className="flex"
                onMouseEnter={() => {
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = setTimeout(show, HOVER_DELAY_MS);
                }}
                onMouseLeave={hide}
                // Keyboard focus only: a click also focuses, and the name is not needed after one.
                onFocus={(e) => (e.target as HTMLElement).matches(":focus-visible") && show()}
                onBlur={hide}
            >
                {children}
            </span>
            {place &&
                createPortal(
                    <span
                        aria-hidden="true"
                        className="animate-fade-soft pointer-events-none fixed z-(--z-tooltip) -translate-y-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#1a1a1a] px-2 py-1 text-xs text-[var(--text-primary)] shadow-[0_4px_14px_rgba(0,0,0,0.5)]"
                        style={{ top: place.top, left: place.left }}
                    >
                        {label}
                    </span>,
                    document.body,
                )}
        </>
    );
}
