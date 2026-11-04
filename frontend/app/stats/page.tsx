"use client";

/**
 * Stats: the listener, then the server, one chapter at a time. Amber is only
 * ever data, a figure is stated once, and music time is an estimate that says "about".
 */

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { ShapePlot } from "@/features/stats/components/ShapePlot";
import { ListeningClock } from "@/features/stats/components/ListeningClock";
import { Coverage } from "@/features/stats/components/Coverage";
import { Decades } from "@/features/stats/components/Decades";
import { SourceSplit } from "@/features/stats/components/SourceSplit";
import { SpokenWord } from "@/features/stats/components/SpokenWord";
import { SignatureSound, OwnedAgainstPlayed } from "@/features/stats/components/Signature";
import { KeyWheel } from "@/features/stats/components/KeyWheel";
import { EnergyCurve } from "@/features/stats/components/EnergyCurve";
import { ServerPanel } from "@/features/stats/components/ServerPanel";
import { FalseStarts } from "@/features/stats/components/FalseStarts";
import { Chapters, type Chapter } from "@/features/stats/components/Chapters";
import { hourLabel, hoursValue, monthYear, percent, whenLabel } from "@/features/stats/format";
import { Finding, PlayCore } from "@/features/stats/components/Finding";
import { usePlaySlice } from "@/features/stats/usePlaySlice";
import Link from "next/link";
import { Play } from "lucide-react";
import { PERIODS, type Period, type ListeningStats, type StatsResponse } from "@/features/stats/types";
import { PageMessage } from "@/components/ui/PageMessage";
import { useMediaQuery } from "@/hooks/useMediaQuery";

export default function StatsPage() {
    const { isAuthenticated, isLoading: authLoading } = useAuth();
    const stacked = useMediaQuery("(max-width: 1023px)");
    const compact = useMediaQuery("(max-width: 639px), (max-height: 560px)");
    const [data, setData] = useState<StatsResponse | null>(null);
    const [failed, setFailed] = useState(false);
    // One period for the whole page, so every figure is comparable to the others.
    const [period, setPeriod] = useState<Period>("all");
    const [reloading, setReloading] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!isAuthenticated) return;
        let cancelled = false;
        (async () => {
            // The old figures stay on screen while the new period loads, so two
            // periods can be compared.
            if (data) setReloading(true);
            try {
                // The hour-of-day grid is bucketed on the listener's wall clock.
                const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const res = await api.get<StatsResponse>(
                    `/stats?tz=${encodeURIComponent(tz)}&period=${period}`,
                );
                if (!cancelled) { setData(res); setFailed(false); }
            } catch {
                // Writing `period` here would refire this effect; the control is
                // reconciled at render against the loaded period instead.
                if (!cancelled) setFailed(true);
            } finally {
                if (!cancelled) setReloading(false);
            }
        })();
        return () => { cancelled = true; };
        // `data` only decides whether this is a first load or a period change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isAuthenticated, period, attempt]);

    if (authLoading || (!data && !failed)) return <Waiting />;

    // A failed period switch keeps the figures already on screen.
    if (!data) {
        return (
            <PageMessage
                title="couldn't load stats"
                action={{ label: "try again", onClick: () => { setFailed(false); setAttempt((n) => n + 1); } }}
            />
        );
    }

    const { listening, shelf, spoken, signature, system } = data;
    const hasPlays = listening.plays > 0;
    // After a failed switch the control shows the period whose figures are on screen.
    const shown = failed ? data.period : period;

    // The claim over the energy curve is read from the numbers the curve draws.
    const played = signature.hourly.filter((h) => h.plays > 0);
    const frantic = played.length > 2
        ? played.reduce((a, b) => (b.energy > a.energy ? b : a))
        : null;

    const analysed = shelf.analysis.done.toLocaleString();
    const topKey = signature.key?.top[0]?.key;
    const keyClaim = topKey ? `top key: ${topKey.toLowerCase()}` : "keys";

    const sources = (
        <>
            <Column label="podcasts & audiobooks">
                <SpokenWord spoken={spoken} />
            </Column>
            {hasPlays && (
                <Column label="play sources">
                    <SourceSplit listening={listening} />
                </Column>
            )}
        </>
    );

    const chapters: Chapter[] = [
        {
            id: "overview",
            label: "overview",
            content: hasPlays
                ? <Overview listening={listening} shelf={shelf} signature={signature} period={shown} withShape={!stacked} />
                : <NoPlays period={shown} />,
        },
        // Where the Overview stacks, the plot has no room beside the figures and gets its own chapter.
        ...(hasPlays && stacked ? [{
            id: "shape",
            label: "brightness & energy",
            content: (
                <div className="mx-auto w-full max-w-[max(10rem,calc(var(--fit-h)-13.5rem))]">
                    <ShapePlot listening={listening} period={shown} />
                </div>
            ),
        }] : []),
        ...(hasPlays ? [{
            id: "played",
            label: "most played",
            content: <TopLists listening={listening} period={shown} />,
        }] : []),
        ...(hasPlays && listening.peak ? [{
            id: "rhythm",
            label: "by hour",
            content: (
                <Finding
                    claim={`busiest hour: ${whenLabel(listening.peak.weekday, listening.peak.hour)}`}
                    note="plays by day and hour · local time"
                    evidence={<ListeningClock listening={listening} period={shown} />}
                />
            ),
        }] : []),
        ...(hasPlays && signature.key && !stacked ? [{
            id: "mood",
            label: "keys",
            content: (
                <Finding
                    claim={frantic ? `highest energy: around ${hourLabel(frantic.hour)}` : keyClaim}
                    note={`from audio analysis of ${analysed} tracks · click a key to play it`}
                    evidence={<SignatureSound signature={signature} period={shown} />}
                />
            ),
        }] : []),
        // Stacked, the wheel and the energy curve each need the full panel.
        ...(hasPlays && signature.key && stacked ? [{
            id: "mood",
            label: "keys",
            content: (
                <Finding
                    claim={keyClaim}
                    note={`from audio analysis of ${analysed} tracks · tap a key to play it`}
                    evidence={<KeyWheel keys={signature.key} period={shown} />}
                />
            ),
        }] : []),
        ...(hasPlays && stacked && frantic && signature.hourly.length > 3 ? [{
            id: "energy",
            label: "energy by hour",
            content: (
                <Finding
                    claim={`highest energy: around ${hourLabel(frantic.hour)}`}
                    note="average track energy of plays, by hour"
                    evidence={<EnergyCurve hourly={signature.hourly} />}
                />
            ),
        }] : []),
        {
            id: "unplayed",
            label: "unplayed",
            content: (
                <Finding
                    claim={`${shelf.neverPlayed.toLocaleString()} ${shelf.neverPlayed === 1 ? "track" : "tracks"} never played`}
                    scope={shown === "all" ? undefined : "all time"}
                    evidence={
                        <div className="flex flex-col gap-(--stat-gap-block)">
                            <Coverage shelf={shelf} />
                            {!compact && shelf.decades.length > 1 && <Decades decades={shelf.decades} />}
                        </div>
                    }
                />
            ),
        },
        // On compact screens the decades and the sources each get a chapter of their own.
        ...(compact && shelf.decades.length > 1 ? [{
            id: "decades",
            label: "decades",
            content: (
                <Aside note={shown === "all" ? undefined : "all time"}>
                    <Decades decades={shelf.decades} />
                </Aside>
            ),
        }] : []),
        {
            id: "also",
            label: "other stats",
            content: (
                <Aside note={shown === "all" ? undefined : "all time"}>
                    <div className="grid gap-x-12 gap-y-(--stat-gap-block) sm:grid-cols-2 lg:grid-cols-3">
                        {signature.ownedVsPlayed.length > 0 && (
                            <Column label="library vs played">
                                <OwnedAgainstPlayed signature={signature} />
                            </Column>
                        )}
                        {!compact && sources}
                    </div>
                </Aside>
            ),
        },
        ...(compact ? [{
            id: "sources",
            label: "sources",
            content: (
                <Aside note={shown === "all" ? undefined : "all time"}>
                    <div className="flex flex-col gap-(--stat-gap-block)">{sources}</div>
                </Aside>
            ),
        }] : []),
        ...(system ? [{
            id: "health",
            label: "server",
            content: (
                <Aside note={`kima ${system.version}`}>
                    <ServerPanel system={system} />
                </Aside>
            ),
        }] : []),
        { id: "false-starts", label: "play history cleanup", fill: true, content: <FalseStarts /> },
    ];

    return (
        <Frame
            controls={
                <>
                    {shown === "all" && hasPlays && listening.firstPlay && (
                        <p className="t-meta hidden sm:block">since {monthYear(listening.firstPlay)}</p>
                    )}
                    <PeriodPicker value={shown} onChange={setPeriod} busy={reloading} />
                </>
            }
            status={
                failed ? (
                    <p className="t-meta text-[var(--text-secondary)]" role="status">
                        couldn&apos;t load that period · showing {PERIODS.find((p) => p.id === shown)?.label ?? "all time"}
                    </p>
                ) : null
            }
        >
            <Chapters
                chapters={chapters}
                aside={<PeriodSelect value={shown} onChange={setPeriod} busy={reloading} />}
            />
        </Frame>
    );
}

/* ── The chapters ────────────────────────────────────────────────────────── */

/** One sentence, the four counts, the readings, and the taste plot beside them. */
function Overview({
    listening,
    shelf,
    signature,
    period,
    withShape,
}: {
    listening: ListeningStats;
    shelf: StatsResponse["shelf"];
    signature: StatsResponse["signature"];
    period: Period;
    withShape: boolean;
}) {
    const heard = percent(shelf.tracks.heard, shelf.tracks.total);
    const window = PERIODS.find((p) => p.id === period)?.sentence ?? "";

    const facts: Array<{ value: string; note: string }> = [
        listening.peak && {
            value: whenLabel(listening.peak.weekday, listening.peak.hour),
            note: "busiest hour of the week",
        },
        signature.concentration && {
            value: `${signature.concentration.forHalf} ${signature.concentration.forHalf === 1 ? "track" : "tracks"}`,
            note: signature.concentration.forHalf === 1 ? "makes up half your plays" : "make up half your plays",
        },
        signature.key && {
            value: `${Math.round(signature.key.minorPct)}% minor key`,
            note: signature.key.top[0]?.key ? `top key: ${signature.key.top[0].key.toLowerCase()}` : "",
        },
        signature.albumHabit && {
            value: `${Math.round(signature.albumHabit.inOrderPct)}%`,
            note: "played in album order",
        },
        signature.era && {
            value: String(signature.era.medianYear),
            note: "median release year",
        },
    ].filter(Boolean) as Array<{ value: string; note: string }>;

    return (
        <div className="grid items-start gap-x-16 gap-y-(--stat-gap-block) lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
            <div className="flex flex-col gap-(--stat-gap-block)">
                <h1
                    className="text-[length:var(--stat-hero)] leading-[1.02] font-light tracking-[-0.03em] text-[var(--text-primary)] text-balance"
                    aria-label={`about ${hoursValue(listening.estimatedSeconds)} hours of music ${window}`.trim()}
                >
                    about{" "}
                    <span className="t-figure text-[length:var(--stat-hero)]">
                        {hoursValue(listening.estimatedSeconds)}
                    </span>{" "}
                    hours of music{window ? ` ${window}` : ""}
                </h1>

                {/* The hours are an estimate and say so; these four counts are exact. The columns follow the
                    room this block has, not the screen: open sidebars can leave it narrow on a wide one. */}
                <dl className="grid grid-cols-2 min-[480px]:grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-4 gap-y-6 sm:gap-x-8 lg:max-w-[42rem]">
                    <Reading value={listening.plays.toLocaleString()} label="plays" />
                    <Reading value={listening.distinctArtists.toLocaleString()} label="artists" />
                    <Reading value={listening.distinctAlbums.toLocaleString()} label="albums" />
                    <Reading value={`${heard}%`} label={period === "all" ? "of library played" : "of library played · all time"} />
                </dl>

                <div className="flex flex-col gap-5">
                    {/* Short phone screens keep the first three facts. */}
                    <dl className="flex flex-col lg:max-w-[42rem] short:max-sm:[&>div:nth-child(n+4)]:hidden">
                        {facts.map((f) => (
                            <div
                                key={f.value}
                                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-white/[0.05] py-2.5 last:border-0"
                            >
                                <dt className="t-figure text-[length:var(--stat-lead)] leading-tight">
                                    {f.value}
                                </dt>
                                {f.note && <dd className="t-body">{f.note}</dd>}
                            </div>
                        ))}
                    </dl>
                    {signature.concentration && (
                        <PlayCore count={signature.concentration.forHalf} period={period} />
                    )}
                </div>
            </div>

            {withShape && (
                <div className="w-full justify-self-end max-w-[max(16rem,calc(var(--fit-h)-13.5rem))]">
                    <ShapePlot listening={listening} period={period} />
                </div>
            )}
        </div>
    );
}

/** The Overview when the period holds no plays; the period picker stays above it as the way out. */
function NoPlays({ period }: { period: Period }) {
    return (
        <div className="flex flex-col gap-4">
            <h1 className="text-[length:var(--stat-hero)] leading-[1.02] font-light tracking-[-0.03em] text-[var(--text-primary)]">
                {period === "all" ? "no plays yet" : "no plays in this period"}
            </h1>
            <p className="t-body leading-relaxed max-w-[48ch]">
                {period === "all"
                    ? "a play counts after half the track"
                    : "try a longer period"}
            </p>
        </div>
    );
}

/**
 * The one period every listening figure is measured over. The live option is
 * underlined in the same amber the coverage figures use.
 */
function PeriodPicker({
    value,
    onChange,
    busy,
}: {
    value: Period;
    onChange: (p: Period) => void;
    busy: boolean;
}) {
    return (
        <div
            role="group"
            aria-label="period"
            aria-busy={busy}
            className={`flex items-baseline gap-4 transition-opacity ${busy ? "opacity-50" : ""}`}
        >
            {PERIODS.map((p) => {
                const live = p.id === value;
                return (
                    <button
                        key={p.id}
                        type="button"
                        onClick={() => onChange(p.id)}
                        aria-pressed={live}
                        className={[
                            "t-control py-1 border-b-[1.5px] transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                            "focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]",
                            live
                                ? "text-[var(--text-primary)] border-brand"
                                : "text-[var(--text-muted)] border-transparent hover:text-[var(--text-secondary)]",
                        ].join(" ")}
                    >
                        {p.label}
                    </button>
                );
            })}
        </div>
    );
}

/** The period picker where the header row is folded into the tab row. */
function PeriodSelect({
    value,
    onChange,
    busy,
}: {
    value: Period;
    onChange: (p: Period) => void;
    busy: boolean;
}) {
    return (
        <select
            aria-label="period"
            aria-busy={busy}
            value={value}
            onChange={(e) => onChange(e.target.value as Period)}
            className={`t-control shrink-0 rounded-lg bg-white/[0.06] px-2 text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${busy ? "opacity-50" : ""}`}
        >
            {PERIODS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
            ))}
        </select>
    );
}

/** A count and what it counts. The count is heavy; the label is not. */
function Reading({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex flex-col gap-2">
            <dd className="t-figure text-[length:var(--stat-figure)]">{value}</dd>
            <dt className="t-label leading-snug">{label}</dt>
        </div>
    );
}

/* ── Structure ───────────────────────────────────────────────────────────── */

/** A chapter that reports rather than argues, with one fact about it set above. */
function Aside({ note, children }: { note?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-5">
            {note && <p className="t-meta">{note}</p>}
            {children}
        </div>
    );
}

/** One column of the readings strip. */
function Column({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-4">
            <h3 className="t-label text-[var(--text-secondary)]">{label}</h3>
            {children}
        </div>
    );
}

/** The page at exactly the height of the content area, so only the chapters move. */
function Frame({
    controls,
    status,
    children,
}: {
    controls: React.ReactNode;
    status?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className="page-shell relative flex h-full flex-col pt-6 pb-[var(--stats-under)] compact:pt-1">
            <div className="compact:hidden flex flex-wrap items-baseline gap-x-6 gap-y-2 pb-3">
                <div className="flex items-baseline gap-4">{controls}</div>
            </div>
            {status}
            {children}
        </div>
    );
}

/* ── The lists ───────────────────────────────────────────────────────────── */

function TopLists({ listening, period }: { listening: ListeningStats; period: Period }) {
    return (
        <div className="grid gap-(--stat-gap-block) sm:grid-cols-2 sm:gap-x-16">
            <Ranked
                label="artists"
                kind="artist"
                period={period}
                items={listening.topArtists.map((a) => ({
                    key: a.id,
                    id: a.id,
                    primary: a.name,
                    count: a.plays,
                }))}
            />
            <Ranked
                label="tracks"
                kind="track"
                period={period}
                items={listening.topTracks.map((t) => ({
                    key: t.id,
                    id: t.id,
                    primary: t.title,
                    secondary: t.artist,
                    count: t.plays,
                }))}
            />
        </div>
    );
}

function Ranked({
    label,
    items,
    kind,
    period,
}: {
    label: string;
    items: Array<{ key: string; id?: string; primary: string; secondary?: string; count: number }>;
    /** Tracks play where they sit; artists go to their page. */
    kind: "track" | "artist";
    /** So pressing a row plays the window the list was drawn from. */
    period: Period;
}) {
    const { play, busy } = usePlaySlice();

    return (
        <div className="flex flex-col gap-3">
            <h3 className="t-label text-[var(--text-secondary)]">{label}</h3>
            {/* Phones and tablets show the top five, short screens the top four, so both lists fit one panel. */}
            <ol className="flex flex-col gap-1.5 max-lg:[&>li:nth-child(n+6)]:hidden short:max-lg:[&>li:nth-child(n+5)]:hidden">
                {items.map((item, i) => {
                    const inner = (
                        <>
                            <span className="min-w-0 flex items-baseline gap-3">
                                <span className="t-meta w-3 shrink-0 text-right">{i + 1}</span>
                                <span className="min-w-0">
                                    <span
                                        className={`block truncate text-sm leading-tight text-[var(--text-primary)] ${
                                            i === 0 ? "font-semibold" : "font-normal"
                                        }`}
                                    >
                                        {item.primary}
                                    </span>
                                    {item.secondary && (
                                        <span className="block truncate t-meta">{item.secondary}</span>
                                    )}
                                </span>
                            </span>
                            <span className="flex items-center gap-2 shrink-0">
                                {kind === "track" && (
                                    <Play
                                        aria-hidden
                                        className="w-3.5 h-3.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
                                    />
                                )}
                                <span className="t-figure text-xs text-[var(--text-secondary)]">
                                    {item.count.toLocaleString()}
                                </span>
                            </span>
                        </>
                    );
                    const shared =
                        "group t-touch-row w-full flex items-center justify-between gap-4 rounded px-2 -mx-2 py-1 -my-1 text-left " +
                        "transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 " +
                        "focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]";

                    return (
                        <li key={item.key}>
                            {kind === "artist" && item.id ? (
                                <Link href={`/artist/${item.id}`} className={shared}>
                                    {inner}
                                </Link>
                            ) : kind === "track" ? (
                                <button
                                    type="button"
                                    onClick={() => play("top", { limit: items.length, startIndex: i, token: item.key, period })}
                                    disabled={busy === item.key}
                                    aria-label={`play ${item.primary}`}
                                    className={shared + (busy === item.key ? " opacity-60" : "")}
                                >
                                    {inner}
                                </button>
                            ) : (
                                <span className={shared.replace("hover:bg-white/[0.05]", "")}>{inner}</span>
                            )}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

function Waiting() {
    return (
        <Frame controls={<div className="h-4 w-40 rounded bg-white/[0.04] animate-pulse" />}>
            <div className="flex gap-6 border-b border-white/[0.08] py-3">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-3 w-16 rounded bg-white/[0.05] animate-pulse" />
                ))}
            </div>
            <div className="flex flex-col gap-(--stat-gap-block) pt-6" aria-busy="true" aria-label="loading stats">
                <div className="h-12 w-80 max-w-full rounded bg-white/[0.04] animate-pulse" />
                <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <div key={i} className="flex flex-col gap-2">
                            <div
                                className="h-8 w-20 rounded bg-white/[0.04] animate-pulse"
                                style={{ animationDelay: `${i * 90}ms` }}
                            />
                            <div className="h-2.5 w-14 rounded bg-white/[0.025] animate-pulse" />
                        </div>
                    ))}
                </div>
            </div>
        </Frame>
    );
}
