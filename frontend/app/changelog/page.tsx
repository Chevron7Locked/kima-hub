"use client";

/**
 * The permanent changelog: every release Kima has shipped, newest first, additive — a release's note and its
 * requirements stay here forever, never overwritten by the next version. Each item carries what the server knows:
 * the recorded answer, the action verifiably done, or a quiet "open" until it is. Reading this page writes nothing;
 * it only runs what the item itself offers. Deep links: /changelog#1.11.0 lands on that release.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { shortVersion } from "@/lib/format";
import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/lib/cn";
import { ReleaseBody } from "@/components/whats-new/ReleaseBody";
import { ReleaseLinks } from "@/components/whats-new/ReleaseLinks";
import { WipeAction } from "@/components/whats-new/WipeAction";
import { RefileAction } from "@/components/whats-new/RefileAction";
import { CHANGELOG } from "@/components/whats-new/useVersionChip";
import type { Release, ReleaseItem } from "@/components/whats-new/types";

/** A release item as the changelog reads it: the window's item plus what the server knows about it now. */
type ChangelogItem = ReleaseItem & { answer?: { enabled: boolean; decidedBy: string }; done?: boolean; open?: boolean };
type ChangelogRelease = Omit<Release, "items"> & { dismissed: boolean; items: ChangelogItem[] };

const niceDate = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export default function ChangelogPage() {
    // Read again on every visit: an item can settle on the server (a re-run finishing, another device's answer).
    const changelog = useQuery({
        queryKey: CHANGELOG,
        queryFn: () => api.get<{ releases: ChangelogRelease[] }>("/whats-new/changelog"),
        staleTime: 0,
    });
    const data = changelog.data ?? null;
    const error = changelog.isError && !data ? "Couldn't load the changelog." : null;
    const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());

    // A deep link like /changelog#1.11.0 opens that release's items until the reader opens or closes one...
    const [chosen, setChosen] = useState<Set<string> | null>(null);
    const linkedItems = useMemo(() => {
        const hash = typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1));
        return new Set(data && hash ? collectItemKeys(data.releases, hash) : []);
    }, [data]);
    const openItems = chosen ?? linkedItems;

    // ...and lands on it once it is first drawn; a reload of the list (after an action settles) does not scroll.
    const landed = useRef(false);
    useEffect(() => {
        if (!data || landed.current) return;
        landed.current = true;
        const hash = decodeURIComponent(window.location.hash.slice(1));
        const target = hash ? document.getElementById(hash) : null;
        if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
    }, [data]);

    const toggle = (key: string) =>
        setChosen((s) => {
            const next = new Set(s ?? linkedItems);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    if (error) {
        return (
            <div className="px-5 py-10">
                <p className="text-sm text-[var(--text-secondary)]">{error}</p>
            </div>
        );
    }
    if (!data) {
        return (
            <div className="px-5 py-10 flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading the changelog...
            </div>
        );
    }

    const openItemsList = data.releases.flatMap((r) => r.items.filter((i) => i.open).map((i) => ({ release: r, item: i })));

    return (
        <div className="px-5 page-end max-w-3xl mx-auto">
            <PageHeader className="px-0" title="Changelog" description="Every release, newest first. Notes stay, requests stay, until the server can see they're done." />

            {openItemsList.length > 0 && (
                <section aria-label="Still open" className="mt-6 flex flex-col gap-1 rounded-xl border border-brand/30 bg-brand/[0.05] p-4">
                    <h2 className="text-sm font-semibold text-brand">{openItemsList.length === 1 ? "One thing is still open" : `${openItemsList.length} things are still open`}</h2>
                    <p className="text-xs text-[var(--text-muted)]">From releases you already read. They close themselves when they truly happen.</p>
                    <ul className="mt-1 flex flex-col">
                        {openItemsList.map(({ release, item }) => (
                            <li key={`${release.version}:${item.key}`}>
                                <a
                                    href={`#${release.version}`}
                                    onClick={() => setChosen((s) => new Set([...(s ?? linkedItems), item.key]))}
                                    className="flex items-center gap-2 py-2 text-sm text-white hover:underline underline-offset-4 decoration-white/30"
                                >
                                    <span className="shrink-0 min-[420px]:hidden">•</span>
                                    {item.title}
                                    <span className="text-xs text-[var(--text-muted)]">· from {shortVersion(release.version)}</span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <div className="mt-8 flex flex-col">
                {data.releases.map((r) => (
                    <section key={r.version} id={r.version} className="scroll-mt-24 py-8 border-b border-white/[0.06] last:border-b-0" aria-labelledby={`cl-${r.version}`}>
                        <header className="flex items-baseline justify-between gap-3 flex-wrap">
                            <h2 id={`cl-${r.version}`} className="text-xl font-bold tracking-tight text-white">
                                {r.title}
                            </h2>
                            <p className="text-xs text-[var(--text-muted)]">
                                {niceDate(r.date)}
                                {r.dismissed ? "" : " · you haven't read it yet"}
                            </p>
                        </header>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{r.summary}</p>

                        {r.note && (
                            <figure className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-5">
                                <figcaption className="text-sm font-semibold text-white">A note from {r.note.from}</figcaption>
                                <ReleaseBody size="page" text={r.note.body} />
                                <p className="pt-2 text-sm font-medium text-white">{r.note.from}</p>
                            </figure>
                        )}

                        <ul className="mt-4 flex flex-col divide-y divide-white/[0.06]">
                            {r.items.map((item) => (
                                <li key={item.key} id={item.key} className="scroll-mt-24 py-3">
                                    <button
                                        type="button"
                                        onClick={() => toggle(item.key)}
                                        aria-expanded={openItems.has(item.key)}
                                        className="w-full flex items-center gap-3 text-left py-1 group"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="text-sm font-medium text-white">{item.title}</span>
                                            <span className="mt-0.5 block text-sm leading-snug text-[var(--text-secondary)]">{item.summary}</span>
                                        </span>
                                        <StateChip item={item} ranNow={doneKeys.has(item.key)} />
                                        <ChevronDown className={cn("w-4 h-4 shrink-0 text-[var(--text-muted)] transition-transform", openItems.has(item.key) && "rotate-180")} />
                                    </button>
                                    {openItems.has(item.key) && (
                                        <div className="pl-0 sm:pl-1 pb-2 flex flex-col gap-3">
                                            <ReleaseBody size="page" text={item.body} />
                                            {item.kind === "choice" && !item.answer && <p className="text-xs text-[var(--text-muted)]">You haven&apos;t answered. It stays off.</p>}
                                            {item.kind === "action" && item.open && (
                                                <div className="flex flex-col gap-2">
                                                    {item.run === "wipeEnrichment" && (
                                                        <WipeAction
                                                            item={item}
                                                            done={doneKeys.has(item.key) || !!item.done}
                                                            onDone={() => setDoneKeys((d) => new Set([...d, item.key]))}
                                                        />
                                                    )}
                                                    {item.run === "refileAlbums" && (
                                                        <RefileAction
                                                            item={item}
                                                            done={doneKeys.has(item.key) || !!item.done}
                                                            onDone={() => setDoneKeys((d) => new Set([...d, item.key]))}
                                                        />
                                                    )}
                                                    {item.ifClosed && <p className="text-xs text-[var(--text-muted)] max-w-[62ch]">{item.ifClosed}</p>}
                                                </div>
                                            )}
                                            {item.links && <ReleaseLinks links={item.links} />}
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>

        </div>
    );
}

function collectItemKeys(releases: ChangelogRelease[], version: string): string[] {
    return releases.find((r) => r.version === version)?.items.map((i) => i.key) ?? [];
}

function StateChip({ item, ranNow }: { item: ChangelogItem; ranNow: boolean }) {
    if (item.open) return <span className="shrink-0 text-xs font-medium text-brand">open</span>;
    if (item.done || ranNow) return <span className="shrink-0 flex items-center gap-1 text-xs text-success"><Check className="w-3.5 h-3.5" />done</span>;
    if (item.answer) {
        const said = item.answer.enabled ? "on" : "off";
        return <span className="shrink-0 text-xs text-[var(--text-muted)]">{item.answer.decidedBy === "EXPLICIT" ? `you said ${said}` : `${said}, unanswered`}</span>;
    }
    return null;
}

