"use client";

/**
 * The release window, the one surface allowed to block. It opens on the newest release's note and a list of what's
 * new, that release's items first and any older unseen release's after; each line opens that item's own page. Items
 * are a `note`, an `action`, or a `choice` whose default is off. Closing answers no to every untouched choice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X, Check, Loader2, ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";

interface ReleaseLink {
    label: string;
    href: string;
}

interface ItemBase {
    key: string;
    title: string;
    summary: string;
    body: string;
    links?: ReleaseLink[];
}

type ReleaseItem =
    | (ItemBase & { kind: "note" })
    | (ItemBase & {
          kind: "action";
          cta: string;
          run?: "wipeEnrichment";
          confirmTitle?: string;
          confirmMessage?: string;
          confirmLabel?: string;
          /** What closing without acting means for this item; said in the footer. */
          ifClosed?: string;
          requires?: "savedMoodMix" | "retiredMoodMix" | "admin";
      })
    | (ItemBase & { kind: "choice"; defaultValue: false; discloses?: string; requires?: "admin" });

export interface Release {
    version: string;
    title: string;
    summary: string;
    date: string;
    note?: { from: string; body: string };
    items: ReleaseItem[];
}

/** A click that replaces this page: a plain left click. Cmd, ctrl, shift or a middle click opens another tab or window. */
export function opensHere(e: React.MouseEvent): boolean {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function WhatsNewWindow({
    releases,
    onClose,
    onDismiss,
    renderAction,
    onNavigate,
    done = [],
    answered,
}: {
    /** Every release the user has not closed, oldest first. */
    releases: Release[];
    onClose: () => void;
    /** Records the closing server-side; by default every release in the window is closed. */
    onDismiss?: () => Promise<void>;
    /** An `action` item supplies its own controls; the window only frames them. */
    renderAction?: (item: Extract<ReleaseItem, { kind: "action" }>) => React.ReactNode;
    /** A link to a page in the app was followed. */
    onNavigate?: () => void;
    /** Action items the user has already taken. */
    done?: string[];
    /** Choices already answered, when a closed release is read again. */
    answered?: Record<string, boolean>;
}) {
    const [choices, setChoices] = useState<Record<string, boolean>>(answered ?? {});
    const [closing, setClosing] = useState(false);
    const [closeError, setCloseError] = useState<string | null>(null);
    const [openKey, setOpenKey] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const lastOpened = useRef<string | null>(null);

    const release = releases[releases.length - 1];
    const older = releases.slice(0, -1).reverse();
    const items = releases.flatMap((r) => r.items);
    const versionOf = (key: string) => releases.find((r) => r.items.some((i) => i.key === key))?.version ?? release.version;
    const shortVersion = (version: string) => version.split(".").slice(0, 2).join(".");
    const opened = items.find((i) => i.key === openKey) ?? null;
    const asks = items.filter((i) => i.kind === "choice");
    const unanswered = asks.filter((i) => choices[i.key] === undefined).length;

    // Closes only once the server has the acknowledgement; on failure the window stays open and says so, since the
    // answer was not recorded.
    const close = useCallback(async () => {
        if (closing) return;
        setClosing(true);
        setCloseError(null);
        try {
            if (onDismiss) await onDismiss();
            else for (const r of releases) await api.post(`/whats-new/${r.version}/dismiss`, {});
        } catch {
            setClosing(false);
            setCloseError("Couldn't save. Try again.");
            return;
        }
        onClose();
    }, [releases, onDismiss, onClose, closing]);

    const openItem = (key: string) => {
        lastOpened.current = key;
        setOpenKey(key);
    };

    // Each view starts at its top, and focus follows: the back button on an item's page, the line it came from on
    // the way back.
    useEffect(() => {
        bodyRef.current?.scrollTo(0, 0);
        const target = openKey
            ? dialogRef.current?.querySelector<HTMLElement>("[data-back]")
            : lastOpened.current
              ? dialogRef.current?.querySelector<HTMLElement>(`[data-item="${lastOpened.current}"]`)
              : null;
        target?.focus();
    }, [openKey]);

    // Escape leaves an item's page first; on the overview it closes, which is a real answer, through the same path
    // as the buttons. While a nested confirm is open, Escape belongs to it alone.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (document.querySelector("[data-nested-confirm='true']")) return;
            if (openKey) setOpenKey(null);
            else void close();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [close, openKey]);

    // The window takes the page on purpose, so it owes the keyboard what ConfirmDialog gives: focus lands inside on
    // open, and Tab stays inside while it is up.
    useEffect(() => {
        const prev = document.activeElement as HTMLElement | null;
        dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Tab" || !dialogRef.current) return;
            const focusable = Array.from(
                dialogRef.current.querySelectorAll<HTMLElement>(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
                ),
            ).filter((el) => !el.hasAttribute("disabled"));
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("keydown", onKey);
            prev?.focus?.();
        };
    }, [release.version]);

    const answer = async (key: string, enabled: boolean) => {
        setChoices((c) => ({ ...c, [key]: enabled }));
        try {
            await api.post(`/whats-new/${versionOf(key)}/choice`, { key, enabled });
        } catch {
            setChoices((c) => {
                const n = { ...c };
                delete n[key];
                return n;
            });
        }
    };

    const isDecision = (item: ReleaseItem) => item.kind === "choice" || (item.kind === "action" && (!!item.run || !!item.ifClosed));
    const isOpenDecision = (item: ReleaseItem) =>
        item.kind === "choice" ? choices[item.key] === undefined : isDecision(item) && !done.includes(item.key);
    const waiting = items.filter(isOpenDecision);
    const wide = !!release.note;

    const status = (item: ReleaseItem): string | null => {
        if (item.kind === "choice" && choices[item.key] !== undefined) return choices[item.key] ? "On" : "Off";
        if (item.kind === "action" && done.includes(item.key)) return "Done";
        return null;
    };

    const itemList = (list: ReleaseItem[]) => (
        <ul className="-mx-3 flex flex-col">
            {list.map((item) => {
                const tag = status(item);
                const current = openKey === item.key;
                return (
                    <li key={item.key}>
                        <button
                            type="button"
                            data-item={item.key}
                            aria-current={current ? "true" : undefined}
                            onClick={() => openItem(item.key)}
                            className={`group w-full rounded-lg px-3 py-3 flex items-center gap-3 text-left transition-colors hover:bg-white/[0.06] ${current ? "bg-white/[0.13] ring-1 ring-inset ring-white/[0.07]" : ""}`}
                        >
                            <span className="min-w-0 flex-1">
                                <span className="flex items-baseline justify-between gap-3">
                                    <span className="text-sm font-medium text-white">{item.title}</span>
                                    {tag && <span className="shrink-0 text-xs text-[var(--text-muted)]">{tag}</span>}
                                </span>
                                <span className="mt-0.5 block text-sm leading-snug text-[var(--text-secondary)]">{item.summary}</span>
                            </span>
                            <ChevronRight className="w-4 h-4 shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5" />
                        </button>
                    </li>
                );
            })}
        </ul>
    );

    const group = (id: string, label: string, list: ReleaseItem[]) =>
        list.length > 0 && (
            <div className="flex flex-col gap-1">
                <h4 id={id} tabIndex={-1} className="text-sm font-medium text-[var(--text-secondary)] outline-none">
                    {label}
                </h4>
                {itemList(list)}
            </div>
        );

    const list = (
        <section aria-labelledby="whats-new-list" className="flex flex-col gap-5">
            <h3 id="whats-new-list" className="text-base font-semibold text-white">
                What&apos;s new in {shortVersion(release.version)}
            </h3>
            {group("whats-new-needs", "Needs you", release.items.filter(isDecision))}
            {group("whats-new-changed", "What changed", release.items.filter((i) => !isDecision(i)))}
            {older.map((r) => (
                <div key={r.version}>{group(`whats-new-${r.version}`, `From ${shortVersion(r.version)}`, r.items)}</div>
            ))}
        </section>
    );

    const note = release.note && (
        <section aria-labelledby="whats-new-note" className="flex flex-col gap-4">
            <h3 id="whats-new-note" className="text-base font-semibold text-white">
                A note from {release.note.from}
            </h3>
            <Body text={release.note.body} />
            <p className="pt-1 text-[0.9375rem] font-medium text-white">{release.note.from}</p>
        </section>
    );

    const NEEDS = "__needs";

    const fullView = opened !== null || openKey === NEEDS;

    const backLabel = (
        <>
            <ChevronLeft className="w-4 h-4" />
            What&apos;s new
        </>
    );

    const needsPage = (
        <section aria-labelledby="whats-new-needs-page" className="flex flex-col gap-5 max-w-prose">
            <button
                type="button"
                data-back
                onClick={() => setOpenKey(null)}
                className="-ml-2 self-start min-h-9 py-1.5 pl-1 pr-3 rounded-lg flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-white hover:bg-white/5 transition-colors"
            >
                {backLabel}
            </button>
            <h3 id="whats-new-needs-page" className="text-xl font-semibold tracking-tight text-white text-balance">
                Needs you
            </h3>
            {waiting.map((item) => (
                <div key={item.key} className="flex flex-col gap-3 pt-5 border-t border-white/10">
                    <h4 className="text-base font-semibold text-white">{item.title}</h4>
                    <div className="flex flex-col gap-3">
                        <Body text={item.body} />
                    </div>
                    {item.kind === "choice" && (
                        <div className="flex flex-col gap-3">
                            {item.discloses && (
                                <p className="text-sm leading-relaxed text-[var(--text-secondary)] max-w-[62ch]">
                                    <span className="text-white">What leaves your server: </span>
                                    {item.discloses}
                                </p>
                            )}
                            <div className="flex gap-2">
                                <ChoiceButton selected={choices[item.key] === true} onClick={() => answer(item.key, true)} label="Turn it on" />
                                <ChoiceButton selected={choices[item.key] === false} onClick={() => answer(item.key, false)} label="No thanks" />
                            </div>
                            {choices[item.key] === undefined && (
                                <p className="text-sm text-[var(--text-muted)]">If you don&apos;t answer, it stays off.</p>
                            )}
                        </div>
                    )}
                    {item.kind === "action" && renderAction?.(item)}
                    {item.kind === "action" && item.ifClosed && !done.includes(item.key) && (
                        <p className="text-sm text-[var(--text-muted)] max-w-[62ch]">{item.ifClosed}</p>
                    )}
                </div>
            ))}
        </section>
    );

    const page = (item: ReleaseItem) => (
        <section aria-labelledby="whats-new-item" className="flex flex-col gap-5 max-w-prose">
            <button
                type="button"
                data-back
                onClick={() => setOpenKey(null)}
                className="-ml-2 self-start min-h-9 py-1.5 pl-1 pr-3 rounded-lg flex items-center gap-1 text-sm text-[var(--text-secondary)] hover:text-white hover:bg-white/5 transition-colors"
            >
                {backLabel}
            </button>
            <h3 id="whats-new-item" className="text-xl font-semibold tracking-tight text-white text-balance">
                {item.title}
            </h3>
            <div className="flex flex-col gap-3">
                <Body text={item.body} />
            </div>
            {item.kind === "choice" && (
                <div className="flex flex-col gap-3">
                    {item.discloses && (
                        <p className="text-sm leading-relaxed text-[var(--text-secondary)] max-w-[62ch]">
                            <span className="text-white">What leaves your server: </span>
                            {item.discloses}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <ChoiceButton selected={choices[item.key] === true} onClick={() => answer(item.key, true)} label="Turn it on" />
                        <ChoiceButton selected={choices[item.key] === false} onClick={() => answer(item.key, false)} label="No thanks" />
                    </div>
                </div>
            )}
            {item.kind === "action" && renderAction?.(item)}
            {item.kind === "choice" && choices[item.key] === undefined && (
                <p className="text-sm text-[var(--text-muted)] max-w-[62ch]">If you don&apos;t answer, it stays off.</p>
            )}
            {item.kind === "action" && item.ifClosed && !done.includes(item.key) && (
                <p className="text-sm text-[var(--text-muted)] max-w-[62ch]">{item.ifClosed}</p>
            )}
            {item.links && item.links.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {item.links.map((link) => (
                        <Link
                            key={link.href}
                            href={link.href}
                            onClick={(e) => { if (opensHere(e)) onNavigate?.(); }}
                            className="min-h-11 py-2.5 px-4 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] text-white text-sm font-medium flex items-center gap-2 transition-colors"
                        >
                            {link.label}
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    ))}
                </div>
            )}
        </section>
    );

    const pageBody = opened ? page(opened) : openKey === NEEDS ? needsPage : note;

    return (
        <div
            className="fixed inset-0 z-(--z-modal) flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-6 animate-fade-soft"
            role="dialog"
            aria-modal="true"
            aria-labelledby="whats-new-title"
        >
            <div
                ref={dialogRef}
                className={`w-full ${wide ? "sm:max-w-5xl" : "sm:max-w-2xl"} max-h-[92vh] sm:max-h-[88vh] flex flex-col bg-[var(--bg-secondary)] border border-white/10 rounded-t-2xl sm:rounded-2xl overflow-hidden animate-rise`}
            >
                <header className="shrink-0 px-5 sm:px-6 pt-4 sm:pt-6 pb-4 sm:pb-5 border-b border-white/10 flex items-center justify-between gap-4">
                    <h2 id="whats-new-title" className="text-xl sm:text-2xl font-bold tracking-tight text-white text-balance">
                        {release.title}
                    </h2>
                    <button
                        onClick={close}
                        disabled={closing}
                        aria-label="Close"
                        className="shrink-0 w-11 h-11 -mr-2 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-white/5 transition-colors"
                    >
                        {closing ? <Loader2 className="w-5 h-5 animate-spin" /> : <X className="w-5 h-5" />}
                    </button>
                </header>

                {wide ? (
                    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
                        <div
                            ref={bodyRef}
                            className={`min-h-0 overflow-y-auto px-5 sm:px-6 py-6 border-b lg:border-b-0 lg:border-r border-white/10 ${
                                fullView ? "flex-1 hidden lg:block" : "max-h-[38vh] lg:max-h-none lg:flex-[1.2]"
                            }`}
                        >
                            {pageBody}
                        </div>
                        <div className={`min-h-0 overflow-y-auto px-5 sm:px-6 py-6 ${opened ? "hidden lg:block flex-1" : "flex-1"}`}>
                            {list}
                        </div>
                    </div>
                ) : (
                    <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-6">
                        {opened ? page(opened) : openKey === NEEDS ? needsPage : list}
                    </div>
                )}

                <footer className="shrink-0 px-5 sm:px-6 py-4 border-t border-white/10 flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        {closeError ? (
                            <p className="text-xs text-danger-light" data-testid="whatsnew-close-error" role="alert">
                                {closeError}
                            </p>
                        ) : waiting.length > 0 ? (
                            <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                                <button
                                    type="button"
                                    onClick={() => openItem(NEEDS)}
                                    data-testid="whatsnew-waiting"
                                    className="text-white underline underline-offset-4 decoration-white/30 hover:decoration-white"
                                >
                                    {waiting.length === 1 ? `Needs you: ${waiting[0].title}` : `${waiting.length} things need you`}
                                </button>
                                <span className="hidden sm:inline">. Anything you don&apos;t answer stays as it is.</span>
                            </p>
                        ) : (
                            <p className="text-xs text-[var(--text-muted)]">Press Esc to close.</p>
                        )}
                    </div>
                    <Button
                        variant="primary"
                        onClick={close}
                        disabled={closing}
                        data-autofocus
                        data-testid="whatsnew-done"
                        className="shrink-0"
                    >
                        {closing ? "Saving..." : unanswered > 0 ? "Close" : "Done"}
                    </Button>
                </footer>
            </div>
        </div>
    );
}

/** Blank lines separate paragraphs; a block of lines that each start with "- " is a list. */
function Body({ text }: { text: string }) {
    return (
        <>
            {text.split("\n\n").map((block, i) => {
                const lines = block.split("\n");
                if (lines.every((l) => l.startsWith("- "))) {
                    return (
                        <ul key={i} className="flex flex-col gap-2 pl-5 list-disc marker:text-brand">
                            {lines.map((l, j) => (
                                <li key={j} className="pl-1 text-[0.9375rem] leading-relaxed text-[var(--text-secondary)]">
                                    {l.slice(2)}
                                </li>
                            ))}
                        </ul>
                    );
                }
                return (
                    <p key={i} className="text-[0.9375rem] leading-relaxed text-[var(--text-secondary)] max-w-[62ch]">
                        {block}
                    </p>
                );
            })}
        </>
    );
}

function ChoiceButton({ selected, onClick, label }: { selected: boolean; onClick: () => void; label: string }) {
    return (
        <button
            onClick={onClick}
            aria-pressed={selected}
            className={[
                "h-11 px-4 rounded-lg text-sm font-medium transition-colors flex items-center gap-2",
                selected
                    ? "bg-brand text-black"
                    : "bg-white/[0.04] text-[var(--text-secondary)] hover:text-white hover:bg-white/[0.08]",
            ].join(" ")}
        >
            {selected && <Check className="w-4 h-4" />}
            {label}
        </button>
    );
}
