"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReveal } from "../useReveal";
import { FitPanel } from "./FitPanel";
import { Shortcuts } from "./Shortcuts";
import { tabListKeyDown } from "@/lib/tabListKeys";

export interface Chapter {
    id: string;
    label: string;
    /** Takes the panel's full height and pages itself instead of being scaled down. */
    fill?: boolean;
    content: React.ReactNode;
}

/**
 * One panel per chapter, side by side. Tabs, digit keys and a sideways swipe
 * move between them, the URL hash names the open one, and nothing on the
 * page scrolls vertically. `aside` sits at the end of the tab row on compact screens.
 */
export function Chapters({ chapters, aside }: { chapters: Chapter[]; aside?: React.ReactNode }) {
    const track = useRef<HTMLDivElement>(null);
    const tabRow = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState(chapters[0]?.id ?? "");
    const activeRef = useRef(active);
    const chaptersRef = useRef(chapters);
    /** Index a tab press is gliding to; the swipe sync ignores the panels it passes on the way. */
    const heading = useRef<number | null>(null);
    useLayoutEffect(() => {
        activeRef.current = active;
        chaptersRef.current = chapters;
    });

    const show = useCallback((id: string) => {
        setActive(id);
        window.history.replaceState(null, "", `#${id}`);
    }, []);

    const go = useCallback((i: number, smooth = true) => {
        const el = track.current;
        const chapter = chaptersRef.current[i];
        if (!el || !chapter) return;
        show(chapter.id);
        heading.current = smooth ? i : null;
        el.scrollTo({ left: i * el.clientWidth, behavior: smooth ? "smooth" : "instant" });
    }, [show]);

    useLayoutEffect(() => {
        const wanted = chaptersRef.current.findIndex((c) => c.id === window.location.hash.slice(1));
        if (wanted > 0) go(wanted, false);
    }, [go]);

    // A chapter can disappear when the period changes; fall back to the first.
    useEffect(() => {
        if (chapters.length && !chapters.some((c) => c.id === active)) go(0, false);
    }, [chapters, active, go]);

    useEffect(() => {
        const el = track.current;
        if (!el) return;
        let frame = 0;
        const sync = () => {
            frame = 0;
            const i = Math.round(el.scrollLeft / el.clientWidth);
            if (heading.current !== null) {
                if (i === heading.current && Math.abs(el.scrollLeft - i * el.clientWidth) < 2) heading.current = null;
                return;
            }
            const chapter = chaptersRef.current[i];
            if (chapter && chapter.id !== activeRef.current) show(chapter.id);
        };
        const onScroll = () => {
            if (!frame) frame = requestAnimationFrame(sync);
        };
        const takeOver = () => { heading.current = null; };
        const realign = new ResizeObserver(() => {
            const i = chaptersRef.current.findIndex((c) => c.id === activeRef.current);
            el.scrollLeft = Math.max(0, i) * el.clientWidth;
        });
        el.addEventListener("scroll", onScroll, { passive: true });
        el.addEventListener("pointerdown", takeOver);
        el.addEventListener("wheel", takeOver, { passive: true });
        el.addEventListener("touchstart", takeOver, { passive: true });
        realign.observe(el);
        return () => {
            el.removeEventListener("scroll", onScroll);
            el.removeEventListener("pointerdown", takeOver);
            el.removeEventListener("wheel", takeOver);
            el.removeEventListener("touchstart", takeOver);
            realign.disconnect();
            cancelAnimationFrame(frame);
        };
    }, [show]);

    // Keep the open tab in view when the row is wider than the screen.
    useEffect(() => {
        const row = tabRow.current;
        const tab = row?.querySelector<HTMLElement>(`[data-chapter="${active}"]`);
        if (!row || !tab) return;
        const left = tab.offsetLeft - row.offsetLeft;
        if (left < row.scrollLeft || left + tab.offsetWidth > row.scrollLeft + row.clientWidth) {
            row.scrollTo({ left: left - 16, behavior: "smooth" });
        }
    }, [active]);

    const onTabKey = (e: React.KeyboardEvent<HTMLElement>) =>
        tabListKeyDown(e, chapters.map((c) => c.id), active, (id) => go(chapters.findIndex((c) => c.id === id)));

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-6 border-b border-white/[0.08]">
                <div
                    ref={tabRow}
                    role="tablist"
                    aria-label="stats sections"
                    onKeyDown={onTabKey}
                    className="-mb-px flex min-w-0 flex-1 gap-5 overflow-x-auto scrollbar-hide sm:gap-6"
                >
                    {chapters.map((c, i) => {
                        const open = c.id === active;
                        return (
                            <button
                                key={c.id}
                                id={`tab-${c.id}`}
                                data-chapter={c.id}
                                data-tab-key={c.id}
                                type="button"
                                role="tab"
                                aria-selected={open}
                                aria-controls={`panel-${c.id}`}
                                tabIndex={open ? 0 : -1}
                                onClick={() => go(i)}
                                className={[
                                    "t-control shrink-0 whitespace-nowrap border-b-[1.5px] py-2.5 transition-colors",
                                    "rounded-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60",
                                    open
                                        ? "border-brand text-[var(--text-primary)]"
                                        : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
                                ].join(" ")}
                            >
                                {c.label}
                            </button>
                        );
                    })}
                </div>
                <Shortcuts chapters={chapters} onJump={go} />
                {aside && <div className="hidden shrink-0 py-1 compact:block">{aside}</div>}
            </div>

            <div
                ref={track}
                className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-hide"
            >
                {chapters.map((c) => (
                    <Panel key={c.id} chapter={c} open={c.id === active} />
                ))}
            </div>
        </div>
    );
}

function Panel({ chapter, open }: { chapter: Chapter; open: boolean }) {
    const { ref, shown } = useReveal<HTMLElement>({ threshold: 0.5, rootMargin: "0px" });
    return (
        <section
            ref={ref}
            id={`panel-${chapter.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${chapter.id}`}
            inert={!open}
            className="h-full w-full shrink-0 snap-start snap-always pt-6 compact:pt-4"
        >
            <FitPanel fill={chapter.fill}>
                <div className={`${chapter.fill ? "h-full" : ""} ${shown ? "animate-rise" : "opacity-0"}`}>
                    {chapter.content}
                </div>
            </FitPanel>
        </section>
    );
}
