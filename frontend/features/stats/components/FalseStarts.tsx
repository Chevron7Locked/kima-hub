"use client";

/**
 * The play-history audit. Plays recorded before 1.10.1 include tracks skipped
 * while loading. The only evidence is the gap to the next play, which proves a
 * skip when short and nothing when long, so only provable false starts are
 * raised. Remove deletes them; Ignore stops raising the track. Runs on demand.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { StatTrackRow } from "./StatTrackRow";

interface FalseStartTrack {
    trackId: string;
    title: string;
    artist: string;
    durationSeconds: number;
    requiredSeconds: number | null;
    /** Listens that can be proven nobody stayed for. */
    skipped: number;
    /** Listens proven real by how long the records span. */
    heard: number;
    listens: number;
    rows: number;
    shortestRunSeconds: number | null;
    lastAt: string;
}

interface Audit {
    totalRows: number;
    totalListens: number;
    duplicateRows: number;
    /** Rows a merge would actually remove; fewer than `duplicateRows`. */
    collapsibleRows: number;
    heard: number;
    skipped: number;
    /** Listens of tracks too short to register a play, reported apart from `skipped`. */
    tooShort: number;
    unclear: number;
    earliest: string | null;
    tracks: FalseStartTrack[];
    ignored: Array<{ trackId: string; title: string; artist: string; ignoredAt: string }>;
}

const clock = (n: number) => {
    const t = Math.round(n);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export function FalseStarts() {
    const [audit, setAudit] = useState<Audit | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [arming, setArming] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showIgnored, setShowIgnored] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    // The audit routinely flags hundreds of tracks, so the list shows one
    // page at a time, as many rows as fit the space left under the figures.
    const [page, setPage] = useState(0);
    const listBox = useRef<HTMLDivElement>(null);
    const rows = useRowsThatFit(listBox);

    const load = useCallback(async () => {
        setBusy(true);
        setError(null);
        setElapsed(0);
        // No invented progress bar. The scan is one pass over an entire history
        // and there is no honest fraction to report, so it says what it is doing
        // and -- once the silence is long enough to worry about -- how long for.
        const started = Date.now();
        const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
        try {
            setAudit(await api.get<Audit>("/stats/false-starts"));
            setPicked(new Set());
            setPage(0);
            setArming(false);
        } catch {
            setError("couldn't load play history");
        } finally {
            clearInterval(tick);
            setBusy(false);
        }
    }, []);

    const act = async (path: string, ids: string[], said: (r: Record<string, number>) => string) => {
        setBusy(true);
        setError(null);
        try {
            const result = await api.post<Record<string, number>>(`/stats/false-starts/${path}`, {
                trackIds: ids,
            });
            setNote(said(result ?? {}));
            await load();
        } catch {
            setError("failed · nothing changed");
            setBusy(false);
        }
    };

    if (!audit) {
        return (
            <div className="flex flex-col gap-4 items-start">
                <p className="t-body max-w-[76ch] text-pretty">
                    finds plays logged for tracks you skipped, recorded before version 1.10.1
                </p>
                <Button onClick={load} isLoading={busy}>
                    scan play history
                </Button>
                {busy && (
                    <p className="t-meta" aria-live="polite">
                        scanning
                        {elapsed >= 3 && ` · ${elapsed}s`}
                    </p>
                )}
                {error && <p className="t-meta text-danger-light">{error}</p>}
            </div>
        );
    }

    /** Mirrors `MAX_TRACKS_PER_ACTION` in backend/src/routes/stats.ts, which rejects larger requests. */
    const MAX_PER_ACTION = 2000;
    const all = audit.tracks.map((t) => t.trackId);
    // Compare with what Select all can pick, so it flips to Select none past the cap.
    const selectable = Math.min(all.length, MAX_PER_ACTION);
    const allPicked = selectable > 0 && picked.size === selectable;
    const pickedStarts = audit.tracks
        .filter((t) => picked.has(t.trackId))
        .reduce((n, t) => n + t.skipped, 0);

    const listing = showIgnored ? audit.ignored.length : audit.tracks.length;
    const pages = Math.max(1, Math.ceil(listing / rows));
    const at = Math.min(page, pages - 1);
    const from = at * rows;
    const toggleIgnored = () => {
        setShowIgnored((v) => !v);
        setPage(0);
    };

    return (
        <div className="flex h-full min-h-0 flex-col gap-6">
            <div className="flex flex-wrap items-end gap-x-12 gap-y-4">
                <Figure n={audit.skipped} label="skipped (removable)" tone="brand" />
                <Figure n={audit.heard} label="confirmed" />
                <Figure n={audit.unclear} label="unclear (kept)" />
                {/* Listed whenever there are any: the figures add up to the total, and
                    leaving this bucket out breaks that sum. */}
                {audit.tooShort > 0 && (
                    <Figure n={audit.tooShort} label="track too short to count" />
                )}
                <Figure n={audit.totalListens} label="total plays" />
            </div>

            {audit.collapsibleRows > 0 && (
                <div className="flex flex-col gap-3 items-start">
                    <p className="t-body max-w-[58ch]">
                        <span className="text-[var(--text-primary)]">
                            {audit.totalRows.toLocaleString()} records
                        </span>{" "}
                        for{" "}
                        <span className="text-[var(--text-primary)]">
                            {audit.totalListens.toLocaleString()} {audit.totalListens === 1 ? "play" : "plays"}
                        </span>
                        {` · ${audit.duplicateRows.toLocaleString()} ${audit.duplicateRows === 1 ? "is a duplicate" : "are duplicates"} written mid-track · merging changes no play counts`}
                    </p>
                    <Button
                        onClick={() =>
                            act("collapse", [], (r) =>
                                `merged ${(r.removed ?? 0).toLocaleString()} ${(r.removed ?? 0) === 1 ? "duplicate" : "duplicates"}`,
                            )
                        }
                        isLoading={busy}
                    >
                        merge {audit.collapsibleRows.toLocaleString()} {audit.collapsibleRows === 1 ? "duplicate" : "duplicates"}
                    </Button>
                </div>
            )}

            {note && <p className="t-body text-[var(--text-primary)]">{note}</p>}

            {audit.tracks.length === 0 && !showIgnored && (
                <p className="t-body max-w-[52ch]">
                    nothing to review
                    {audit.ignored.length > 0 && (
                        <>
                            {" "}
                            <button
                                onClick={toggleIgnored}
                                className="t-control text-[var(--text-secondary)] hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                            >
                                show {audit.ignored.length} ignored
                            </button>
                        </>
                    )}
                </p>
            )}

            {listing > 0 && (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-4 pb-3 border-b border-white/[0.08]">
                        {showIgnored ? (
                            <span className="t-meta">
                                {audit.ignored.length} ignored
                            </span>
                        ) : (
                            <>
                                <button
                                    onClick={() => setPicked(allPicked ? new Set() : new Set(all.slice(0, MAX_PER_ACTION)))}
                                    className="t-control text-[var(--text-secondary)] hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
                                >
                                    {allPicked ? "select none" : `select all ${selectable.toLocaleString()}`}
                                </button>
                                <span className="t-meta truncate">
                                    {picked.size > 0
                                        ? `${picked.size} selected · ${pickedStarts.toLocaleString()} ${pickedStarts === 1 ? "play" : "plays"} to remove`
                                        : `${all.length} ${all.length === 1 ? "track" : "tracks"} with skipped plays`}
                                </span>
                            </>
                        )}
                    </div>

                    <div ref={listBox} className="min-h-0 flex-1 overflow-hidden">
                        <ul className="divide-y divide-white/[0.05]">
                            {showIgnored
                                ? audit.ignored.slice(from, from + rows).map((t) => (
                                    <StatTrackRow
                                        key={t.trackId}
                                        className="py-3"
                                        title={t.title}
                                        artist={t.artist}
                                        trailing={
                                            <button
                                                onClick={() => act("restore", [t.trackId], () => "restored")}
                                                disabled={busy}
                                                className="shrink-0 h-9 px-3 rounded-lg t-control text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                            >
                                                restore
                                            </button>
                                        }
                                    />
                                ))
                                : audit.tracks.slice(from, from + rows).map((t) => {
                                    const on = picked.has(t.trackId);
                                    const plays = `${t.listens.toLocaleString()} ${t.listens === 1 ? "play" : "plays"}`;
                                    const counts = `${t.skipped.toLocaleString()} skipped · ${plays}${t.heard > 0 ? ` · ${t.heard} confirmed` : ""}`;
                                    const rule = t.requiredSeconds == null
                                        ? `${clock(t.durationSeconds)} long · too short to count`
                                        : t.shortestRunSeconds == null
                                          ? `counts after ${clock(t.requiredSeconds)}`
                                          : `shortest ${clock(t.shortestRunSeconds)} · counts after ${clock(t.requiredSeconds)}`;
                                    return (
                                        <li key={t.trackId}>
                                            <label className="flex items-center gap-4 py-3 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={on}
                                                    onChange={() =>
                                                        setPicked((s) => {
                                                            const n = new Set(s);
                                                            if (on) n.delete(t.trackId);
                                                            else n.add(t.trackId);
                                                            return n;
                                                        })
                                                    }
                                                    className="w-4 h-4 shrink-0 accent-[var(--color-brand)]"
                                                />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm text-[var(--text-primary)]">
                                                        {t.title}
                                                    </span>
                                                    <span className="block truncate t-meta">{t.artist}</span>
                                                </span>
                                                <span className="min-w-0 max-w-[55%] text-right" title={`${counts}. ${rule}`.toLowerCase()}>
                                                    <span className="block truncate t-meta text-[var(--text-muted)]">
                                                        <span className="text-brand">{t.skipped.toLocaleString()} skipped</span>
                                                        {` · ${plays}`}
                                                        {t.heard > 0 && ` · ${t.heard} confirmed`}
                                                    </span>
                                                    <span className="block truncate t-meta">{rule}</span>
                                                </span>
                                            </label>
                                        </li>
                                    );
                                })}
                        </ul>
                    </div>

                    <div className="flex items-center justify-between gap-4 border-t border-white/[0.08] pt-2">
                        {audit.ignored.length > 0 ? (
                            <button
                                onClick={toggleIgnored}
                                className="h-9 t-control text-[var(--text-muted)] hover:text-white transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                            >
                                {showIgnored
                                    ? "back to results"
                                    : `show ${audit.ignored.length} ignored`}
                            </button>
                        ) : <span />}
                        {pages > 1 && (
                            <div className="flex items-center gap-1">
                                <span className="t-meta mr-2">
                                    {(from + 1).toLocaleString()}–{Math.min(from + rows, listing).toLocaleString()} of {listing.toLocaleString()}
                                </span>
                                <PageButton label="previous page" disabled={at === 0} onClick={() => setPage(at - 1)}>
                                    <ChevronLeft className="w-4 h-4" />
                                </PageButton>
                                <PageButton label="next page" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
                                    <ChevronRight className="w-4 h-4" />
                                </PageButton>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* The consequence is readable before the button is reachable, and the
                delete asks once more with the real number in it. */}
            {picked.size > 0 && !showIgnored && (
                <div className="flex flex-col gap-3">
                    <p className="t-body max-w-[62ch]">
                        <span className="text-[var(--text-primary)]">remove deletes the skipped plays and can&apos;t be undone</span>
                        {" · ignore keeps all plays and stops flagging the track · music files are never touched"}
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            variant={arming ? "primary" : "secondary"}
                            onClick={() =>
                                arming
                                    ? act("remove", [...picked], (r) =>
                                          `removed ${(r.removed ?? 0).toLocaleString()} ${(r.removed ?? 0) === 1 ? "record" : "records"} from ${
                                              r.tracks ?? 0
                                          } ${(r.tracks ?? 0) === 1 ? "track" : "tracks"}`,
                                      )
                                    : setArming(true)
                            }
                            onBlur={() => setArming(false)}
                            isLoading={busy}
                        >
                            {arming
                                ? `delete ${pickedStarts.toLocaleString()} ${pickedStarts === 1 ? "play" : "plays"}?`
                                : `remove skipped plays (${picked.size} ${picked.size === 1 ? "track" : "tracks"})`}
                        </Button>

                        <Button
                            variant="ghost"
                            onClick={() =>
                                act("ignore", [...picked], (r) =>
                                    `ignored ${r.ignored ?? 0} ${(r.ignored ?? 0) === 1 ? "track" : "tracks"}`,
                                )
                            }
                            disabled={busy}
                        >
                            ignore
                        </Button>
                    </div>
                </div>
            )}

            {error && <p className="t-meta text-danger-light">{error}</p>}
        </div>
    );
}

/** How many list rows fit the box, from the height of a rendered row. */
function useRowsThatFit(box: React.RefObject<HTMLDivElement | null>) {
    const [rows, setRows] = useState(6);
    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const measure = () => {
            const row = el.querySelector("li");
            const rowHeight = row ? row.offsetHeight + 1 : 58;
            setRows(Math.max(1, Math.floor(el.clientHeight / rowHeight)));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    });
    return rows;
}

function PageButton({
    label,
    disabled,
    onClick,
    children,
}: {
    label: string;
    disabled: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
            {children}
        </button>
    );
}

function Figure({ n, label, tone }: { n: number; label: string; tone?: "brand" }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span
                className={`t-figure text-[length:var(--stat-figure)] ${
                    tone === "brand" ? "text-brand" : ""
                }`}
            >
                {n.toLocaleString()}
            </span>
            <span className="t-label leading-snug">{label}</span>
        </div>
    );
}
