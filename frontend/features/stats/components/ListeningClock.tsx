"use client";

/**
 * The listening week as a 7x24 grid, Monday first so the weekend rows sit
 * together, bucketed server-side in the viewer's timezone. Hover rewrites the
 * caption locally; click asks the server what was playing in that hour.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useReveal } from "../useReveal";
import { hourLabel, whenLabel } from "../format";
import type { ListeningStats } from "../types";

/** Backend rows are Sunday-first; read them out Monday-first. */
const ROWS = [1, 2, 3, 4, 5, 6, 0];
const ROW_LABELS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const HOUR_TICKS = [0, 6, 12, 18];

interface HourDetail {
    weekday: number;
    hour: number;
    listens: number;
    tracks: Array<{ title: string; artist: string; listens: number }>;
    artists: Array<{ name: string; listens: number }>;
    lastAt: string | null;
}

export function ListeningClock({ listening, period }: { listening: ListeningStats; period?: string }) {
    const { clock, peak, plays } = listening;
    const [at, setAt] = useState<{ dow: number; hour: number } | null>(null);
    const [open, setOpen] = useState<{ dow: number; hour: number } | null>(null);
    // The answer carries the cell and window it was asked for, so a slow answer
    // for a cell the pointer has already left never shows under a newer one.
    const [result, setResult] = useState<{ key: string; detail: HourDetail | null } | null>(null);
    const openKey = open ? `${open.dow}:${open.hour}:${period ?? ""}` : null;
    const detail = result && result.key === openKey ? result.detail : null;
    const loading = openKey !== null && result?.key !== openKey;
    const { ref, shown: revealed } = useReveal<HTMLElement>({ threshold: 0.2 });
    // One cell holds the tab stop and the arrows move between cells; with all 168 in the tab
    // order, passing the grid would take 168 presses.
    const [cursor, setCursor] = useState<{ dow: number; hour: number }>({ dow: 1, hour: 12 });
    const gridRef = useRef<HTMLDivElement | null>(null);

    const max = clock.reduce((m, row) => Math.max(m, ...row), 0);
    const full = fullInkAt(clock);

    const openDow = open?.dow;
    const openHour = open?.hour;
    useEffect(() => {
        if (openDow === undefined || openHour === undefined) return;
        let current = true;
        const key = `${openDow}:${openHour}:${period ?? ""}`;
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        api.get<HourDetail>(
            `/stats/hour?dow=${openDow}&hour=${openHour}&tz=${encodeURIComponent(tz)}${period ? `&period=${period}` : ""}`,
        )
            .then((res) => {
                if (current) setResult({ key, detail: res });
            })
            .catch(() => {
                if (current) setResult({ key, detail: null });
            });
        return () => {
            current = false;
        };
    }, [openDow, openHour, period]);

    // Escape closes whatever is open, the same as clicking the cell again.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            setOpen(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    if (max === 0) {
        return <p className="t-body max-w-[46ch]">no plays yet</p>;
    }

    // The three loudest cells, which is what a finger actually wants to reach.
    const busiest = clock
        .flatMap((row, dow) => row.map((n, hour) => ({ dow, hour, n })))
        .filter((c) => c.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 3);

    // Open wins over hover. Moving the pointer away from an opened cell must not
    // retitle the panel that is still showing that cell's tracks.
    const shown = open ?? at ?? (peak ? { dow: peak.weekday, hour: peak.hour } : null);
    const shownCount = shown ? clock[shown.dow][shown.hour] : 0;
    const isPeak = shown && peak && shown.dow === peak.weekday && shown.hour === peak.hour;

    /** Arrow keys walk the grid; Home and End jump to the ends of a day. */
    const steer = (e: React.KeyboardEvent, dow: number, hour: number) => {
        const rowIndex = ROWS.indexOf(dow);
        const move = (dr: number, dh: number) => {
            e.preventDefault();
            const nextRow = Math.min(ROWS.length - 1, Math.max(0, rowIndex + dr));
            const nextHour = Math.min(23, Math.max(0, hour + dh));
            const next = { dow: ROWS[nextRow], hour: nextHour };
            setCursor(next);
            gridRef.current
                ?.querySelector<HTMLButtonElement>(`[data-cell="${next.dow}-${next.hour}"]`)
                ?.focus();
        };
        switch (e.key) {
            case "ArrowLeft":  return move(0, -1);
            case "ArrowRight": return move(0, 1);
            case "ArrowUp":    return move(-1, 0);
            case "ArrowDown":  return move(1, 0);
            case "Home":       return move(0, -hour);
            case "End":        return move(0, 23 - hour);
        }
    };

    const toggle = (dow: number, hour: number) => {
        if (clock[dow][hour] === 0) return;
        setOpen((o) => (o && o.dow === dow && o.hour === hour ? null : { dow, hour }));
        setResult(null);
    };

    return (
        <figure ref={ref} className="m-0 flex flex-col gap-6">
            <div
                ref={gridRef}
                role="grid"
                aria-label="plays by day and hour. arrow keys move, enter opens an hour"
                className="flex flex-col gap-[3px]"
                onMouseLeave={() => setAt(null)}
            >
                {ROWS.map((dow, rowIndex) => (
                    <div key={dow} className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3">
                        <span
                            className={`t-label text-right transition-colors duration-200 ${
                                shown?.dow === dow ? "text-[var(--text-primary)]" : ""
                            }`}
                        >
                            {ROW_LABELS[rowIndex]}
                        </span>
                        <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
                            {clock[dow].map((n, hour) => {
                                const lit = shown?.dow === dow && shown?.hour === hour;
                                const opened = open?.dow === dow && open?.hour === hour;
                                return (
                                    <button
                                        key={hour}
                                        type="button"
                                        data-cell={`${dow}-${hour}`}
                                        tabIndex={cursor.dow === dow && cursor.hour === hour ? 0 : -1}
                                        onKeyDown={(e) => steer(e, dow, hour)}
                                        aria-label={
                                            n === 0
                                                ? `${whenLabel(dow, hour)}: no plays`
                                                : `${whenLabel(dow, hour)}: ${n} ${n === 1 ? "play" : "plays"}`
                                        }
                                        aria-pressed={opened}
                                        onMouseEnter={() => { if (!open) setAt({ dow, hour }); }}
                                        onFocus={() => { setCursor({ dow, hour }); if (!open) setAt({ dow, hour }); }}
                                        onClick={() => toggle(dow, hour)}
                                        aria-disabled={n === 0}
                                        className={[
                                            "touch-exempt h-6 short:max-sm:h-4 sm:h-7 rounded-[2px] origin-center",
                                            "transition-[box-shadow,opacity] duration-150",
                                            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/70",
                                            n > 0 && "cursor-pointer",
                                            opened && "z-10",
                                        ].filter(Boolean).join(" ")}
                                        style={{
                                            background: cellInk(n, full),
                                            boxShadow: opened
                                                ? "0 0 0 2px #fff"
                                                : lit
                                                  ? "inset 0 0 0 1.5px rgba(255,255,255,0.9)"
                                                  : undefined,
                                            // A diagonal wipe from Monday midnight:
                                            // the week fills in the direction it is
                                            // read, rather than appearing at once.
                                            opacity: revealed ? 1 : 0,
                                            transition: "opacity 340ms ease-out, box-shadow 150ms",
                                            transitionDelay: revealed
                                                ? `${(hour + rowIndex * 2) * 11}ms, 0ms`
                                                : "0ms",
                                        }}
                                    />
                                );
                            })}
                        </div>
                    </div>
                ))}

                <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3 mt-2.5">
                    <span />
                    <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[3px]">
                        {Array.from({ length: 24 }, (_, hour) => (
                            <span key={hour} className="t-meta leading-none whitespace-nowrap">
                                {HOUR_TICKS.includes(hour) ? hourLabel(hour) : ""}
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            {/* On a phone a cell is thirteen pixels wide, which is a picture and
                not a control. Rather than shrink the week to fit a finger — which
                would cost the only thing the grid is for — the busiest hours get
                their own full-width rows underneath, and the grid stays a grid. */}
            <div className="sm:hidden flex flex-col gap-1 -mt-1 short:[&>button:nth-of-type(n+3)]:hidden">
                <h3 className="t-label mb-1">busiest hours</h3>
                {busiest.map(({ dow, hour, n }) => {
                    const opened = open?.dow === dow && open?.hour === hour;
                    return (
                        <button
                            key={`${dow}-${hour}`}
                            type="button"
                            onClick={() => toggle(dow, hour)}
                            aria-disabled={n === 0}
                            aria-pressed={opened}
                            className={[
                                "h-11 px-3 -mx-3 rounded-lg flex items-baseline justify-between gap-4",
                                "transition-colors text-left",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]",
                                opened ? "bg-white/[0.07]" : "active:bg-white/[0.04]",
                            ].join(" ")}
                        >
                            <span className="text-sm text-[var(--text-primary)]">
                                {whenLabel(dow, hour)}
                            </span>
                            <span className="t-meta shrink-0">{n} {n === 1 ? "play" : "plays"}</span>
                        </button>
                    );
                })}
            </div>

            <figcaption className="flex flex-col gap-4">
                {/* Reserved height, so rewriting the line never nudges the page. On phones
                    the busiest-hours rows already say this, so it shows only for an opened hour. */}
                <div className={`min-h-[3.5rem] flex flex-col gap-1 ${open ? "" : "max-sm:hidden"}`} aria-hidden="true">
                    {shown && (
                        <>
                            <p className="t-figure text-[length:var(--stat-lead)] leading-tight">
                                {whenLabel(shown.dow, shown.hour)}
                            </p>
                            <p className="t-meta">
                                {shownCount === 0
                                    ? "no plays"
                                    : `${shownCount.toLocaleString()} ${shownCount === 1 ? "play" : "plays"} · ${(
                                          (shownCount / plays) * 100
                                      ).toFixed(1)}% of all plays`}
                                {isPeak && !open && " · busiest"}
                                {shownCount > 0 && !open && (
                                    <span className="hidden sm:inline"> · click for tracks</span>
                                )}
                                {open && <span className="hidden sm:inline"> · click again to close</span>}
                            </p>
                        </>
                    )}
                </div>

                {/* Rows, not height: a grid track animates cleanly from nothing to
                    whatever the content turns out to be, with no measuring. */}
                <div
                    className="grid transition-[grid-template-rows] duration-300 ease-out"
                    style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
                >
                    <div className="overflow-hidden">
                        {open && <HourPanel detail={detail} loading={loading} />}
                    </div>
                </div>
            </figcaption>
        </figure>
    );
}

/** What was playing in one hour. Two columns, because both questions get asked. */
function HourPanel({ detail, loading }: { detail: HourDetail | null; loading: boolean }) {
    if (loading && !detail) {
        return (
            <div className="pt-1 flex flex-col gap-2" aria-busy="true">
                {[0, 1, 2].map((i) => (
                    <div
                        key={i}
                        className="h-3 rounded bg-white/[0.04] animate-pulse"
                        style={{ width: `${60 - i * 12}%`, animationDelay: `${i * 90}ms` }}
                    />
                ))}
            </div>
        );
    }
    if (!detail || detail.listens === 0) return null;

    return (
        <div className="pt-1 grid gap-x-14 gap-y-7 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] animate-rise">
            <div className="flex flex-col gap-3">
                <h3 className="t-label text-[var(--text-secondary)]">tracks</h3>
                <ol className="flex flex-col gap-2.5">
                    {detail.tracks.map((t, i) => (
                        <li
                            key={`${t.title}-${t.artist}`}
                            className="flex items-baseline justify-between gap-4 animate-rise"
                            style={{ animationDelay: `${Math.min(i, 6) * 45}ms` }}
                        >
                            <span className="min-w-0">
                                <span className="block truncate text-sm text-[var(--text-primary)]">
                                    {t.title}
                                </span>
                                <span className="block truncate t-meta">{t.artist}</span>
                            </span>
                            <span className="t-meta shrink-0 text-[var(--text-secondary)]">
                                {t.listens}
                            </span>
                        </li>
                    ))}
                </ol>
            </div>

            <div className="flex flex-col gap-3">
                <h3 className="t-label text-[var(--text-secondary)]">artists</h3>
                <ul className="flex flex-col gap-2.5">
                    {detail.artists.map((a, i) => (
                        <li
                            key={a.name}
                            className="flex items-baseline justify-between gap-4 animate-rise"
                            style={{ animationDelay: `${Math.min(i, 6) * 45 + 60}ms` }}
                        >
                            <span className="truncate text-sm text-[var(--text-primary)]">{a.name}</span>
                            <span className="t-meta shrink-0 text-[var(--text-secondary)]">
                                {a.listens}
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

/**
 * Where the ink scale tops out: the 85th percentile of non-empty hours, so one
 * heavy evening cannot push every other cell to black.
 */
function fullInkAt(clock: number[][]): number {
    const lit = clock.flat().filter((n) => n > 0).sort((a, b) => a - b);
    if (lit.length === 0) return 1;
    return Math.max(1, lit[Math.floor(lit.length * 0.85)] ?? lit[lit.length - 1]);
}

/** Cell darkness on a gentle curve; one listen still gets visible ink. */
function cellInk(n: number, full: number): string {
    // An empty hour still has to read as a cell: at 3% white on #0a0a0a it is invisible and the
    // grid looks unrendered.
    if (n === 0) return "var(--chart-ink-empty)";
    const share = Math.min(1, Math.pow(n / full, 0.72));
    return `color-mix(in oklab, var(--color-brand) ${Math.round(10 + 90 * share)}%, transparent)`;
}
