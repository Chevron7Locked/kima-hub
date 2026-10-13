"use client";

/**
 * The permanent changelog: every release Kima has shipped, newest first, additive — a release's note and its
 * requirements stay here forever, never overwritten by the next version. Each item carries what the server knows:
 * the recorded answer, the action verifiably done, or a quiet "open" until it is. Reading this page writes nothing;
 * it only runs what the item itself offers. Deep links: /changelog#1.11.0 lands on that release.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronDown, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { PageHeader } from "@/components/layout/PageHeader";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";

interface ChangelogItem {
    key: string;
    kind: "note" | "action" | "choice";
    title: string;
    summary: string;
    body: string;
    cta?: string;
    run?: "wipeEnrichment";
    confirmTitle?: string;
    confirmMessage?: string;
    confirmLabel?: string;
    ifClosed?: string;
    discloses?: string;
    links?: Array<{ label: string; href: string }>;
    answer?: { enabled: boolean; decidedBy: string };
    done?: boolean;
    open?: boolean;
}

interface ChangelogRelease {
    version: string;
    title: string;
    summary: string;
    date: string;
    note?: { from: string; body: string };
    dismissed: boolean;
    items: ChangelogItem[];
}

const shortVersion = (v: string) => v.split(".").slice(0, 2).join(".");
const niceDate = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export default function ChangelogPage() {
    const [data, setData] = useState<{ releases: ChangelogRelease[]; openCount: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [openItems, setOpenItems] = useState<Set<string>>(new Set());
    const [confirm, setConfirm] = useState<{ version: string; item: ChangelogItem } | null>(null);
    const [running, setRunning] = useState(false);
    const [doneKeys, setDoneKeys] = useState<Set<string>>(new Set());
    const firstTarget = useRef<HTMLElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        api
            .get<{ releases: ChangelogRelease[]; openCount: number }>("/whats-new/changelog")
            .then((r) => !cancelled && setData(r))
            .catch(() => !cancelled && setError("Couldn't load the changelog."));
        return () => {
            cancelled = true;
        };
    }, []);

    // A deep link like /changelog#1.11.0: open that release's items and land on it.
    useEffect(() => {
        const hash = decodeURIComponent(window.location.hash.slice(1));
        if (!hash || !data) return;
        const target = document.getElementById(hash);
        if (target) {
            firstTarget.current = target;
            setOpenItems((s) => new Set([...s, ...collectItemKeys(data.releases, hash)]));
            requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
        }
    }, [data]);

    const toggle = (key: string) =>
        setOpenItems((s) => {
            const next = new Set(s);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const runWipe = async () => {
        if (!confirm) return;
        setConfirm(null);
        setRunning(true);
        try {
            await api.wipeAndRerunEnrichment();
            setDoneKeys((d) => new Set([...d, confirm.item.key]));
            notify.info("Wiped. Your library is running through the engine in the background.");
        } catch {
            notify.error("Couldn't start it. Try again, or use Settings, under Library Enrichment.");
        } finally {
            setRunning(false);
        }
    };

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
        <div className="px-5 pb-24 max-w-3xl mx-auto">
            <PageHeader eyebrow="what's new in kima, always" title="Changelog" description="Every release, newest first. Notes stay, requests stay, until the server can see they're done." />

            {openItemsList.length > 0 && (
                <section aria-label="Still open" className="mt-6 flex flex-col gap-1 rounded-xl border border-brand/30 bg-brand/[0.05] p-4">
                    <h2 className="text-sm font-semibold text-brand">{openItemsList.length === 1 ? "One thing is still open" : `${openItemsList.length} things are still open`}</h2>
                    <p className="text-xs text-[var(--text-muted)]">From releases you already read. They close themselves when they truly happen.</p>
                    <ul className="mt-1 flex flex-col">
                        {openItemsList.map(({ release, item }) => (
                            <li key={`${release.version}:${item.key}`}>
                                <a
                                    href={`#${release.version}`}
                                    onClick={() => setOpenItems((s) => new Set([...s, item.key]))}
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
                                {r.dismissed ? "" : " · you haven&apos;t read it yet"}
                            </p>
                        </header>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{r.summary}</p>

                        {r.note && (
                            <figure className="mt-5 rounded-xl border border-white/10 bg-white/[0.03] p-5">
                                <figcaption className="text-sm font-semibold text-white">A note from {r.note.from}</figcaption>
                                <Body text={r.note.body} />
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
                                            <Body text={item.body} />
                                            {item.kind === "choice" && !item.answer && <p className="text-xs text-[var(--text-muted)]">You haven&apos;t answered. It stays off.</p>}
                                            {item.kind === "action" && item.open && (
                                                <div className="flex flex-col gap-2">
                                                    {item.run === "wipeEnrichment" &&
                                                        (doneKeys.has(item.key) || item.done ? (
                                                            <p className="text-sm text-success flex items-center gap-2">
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                                Wiped. Your library is running through the engine in the background.
                                                            </p>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                onClick={() => setConfirm({ version: r.version, item })}
                                                                disabled={running}
                                                                className="self-start min-h-11 py-2.5 px-4 rounded-lg bg-brand hover:bg-brand-hover text-black text-sm font-semibold transition-colors disabled:opacity-60"
                                                            >
                                                                {item.cta}
                                                            </button>
                                                        ))}
                                                    {item.ifClosed && <p className="text-xs text-[var(--text-muted)] max-w-[62ch]">{item.ifClosed}</p>}
                                                </div>
                                            )}
                                            {item.links && item.links.length > 0 && (
                                                <div className="flex flex-wrap gap-2">
                                                    {item.links.map((link) => (
                                                        <Link key={link.href} href={link.href} className="min-h-11 py-2.5 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm font-medium flex items-center gap-2 transition-colors">
                                                            {link.label}
                                                            <ArrowRight className="w-4 h-4" />
                                                        </Link>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>

            {confirm && (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setConfirm(null)}
                    onConfirm={runWipe}
                    title={confirm.item.confirmTitle ?? "Wipe and re-run enrichment?"}
                    message={confirm.item.confirmMessage ?? ""}
                    confirmText={confirm.item.confirmLabel ?? confirm.item.cta ?? "Run it"}
                    cancelText="Not now"
                    variant="warning"
                />
            )}
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

/** Blank lines separate paragraphs; a block of lines that each start with "- " is a list. */
function Body({ text }: { text: string }) {
    return (
        <>
            {text.split("\n\n").map((block, i) => {
                const lines = block.split("\n");
                if (lines.every((l) => l.startsWith("- "))) {
                    return (
                        <ul key={i} className="mt-2 flex flex-col gap-2 pl-5 list-disc marker:text-brand">
                            {lines.map((l, j) => (
                                <li key={j} className="pl-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                                    {l.slice(2)}
                                </li>
                            ))}
                        </ul>
                    );
                }
                return (
                    <p key={i} className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)] max-w-[62ch]">
                        {block}
                    </p>
                );
            })}
        </>
    );
}
