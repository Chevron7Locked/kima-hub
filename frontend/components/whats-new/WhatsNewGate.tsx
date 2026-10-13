"use client";

/**
 * Shows every release the user has not closed in one window, the newest note
 * first and every pending item oldest first, and the current release again on
 * request (the version number beside the logo). The server decides what is
 * pending; nothing is recorded locally, so a second device still asks.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { useAuth } from "@/lib/auth-context";
import { WhatsNewWindow, type Release } from "./WhatsNewWindow";
import { MoodMixChoice } from "./MoodMixChoice";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// One pending fetch per app session, shared across remounts (the layout switching
// between phone, desktop and TV), so a remount neither refetches nor replaces the
// queue being read. A failed fetch is not cached; the next mount retries.
let pendingFetch: Promise<Release[]> | null = null;
let pendingFetchKey: string | null = null;
function fetchPending(): Promise<Release[]> {
    // Keyed to the session token: sign out and in as someone else without a
    // reload, and the new user must not inherit the old user's queue.
    const key = typeof window === "undefined" ? "ssr" : localStorage.getItem("auth_token") ?? "";
    if (!pendingFetch || pendingFetchKey !== key) {
        pendingFetchKey = key;
        pendingFetch = api
            .get<{ releases: Release[] }>("/whats-new/pending")
            .then((r) => r.releases)
            .catch((e) => {
                pendingFetch = null;
                throw e;
            });
    }
    return pendingFetch;
}

/** Everything was closed: a remount must not bring the window back from the cached fetch. */
function closeAll(): void {
    pendingFetch = Promise.resolve([]);
}

const OPEN_EVENT = "kima:whats-new-open";

/** Opens the window on the current release again, closed or not (the version number beside the logo). */
export function openWhatsNew(): void {
    window.dispatchEvent(new Event(OPEN_EVENT));
}

/** The version number's door: unread news opens the window; otherwise it opens the permanent /changelog. */
export async function openWhatsNewOrChangelog(push: (href: string) => void): Promise<void> {
    try {
        if ((await fetchPending()).length > 0) openWhatsNew();
        else push("/changelog");
    } catch {
        push("/changelog");
    }
}

let openCountFetch: Promise<number> | null = null;
let openCountKey: string | null = null;

/** Open requirements the server cannot yet see done — one fetch per session, per user. */
export function fetchOpenCount(): Promise<number> {
    const key = typeof window === "undefined" ? "ssr" : localStorage.getItem("auth_token") ?? "";
    if (!openCountFetch || openCountKey !== key) {
        openCountKey = key;
        openCountFetch = api
            .get<{ count: number }>("/whats-new/open")
            .then((r) => r.count)
            .catch(() => {
                openCountFetch = null;
                return 0;
            });
    }
    return openCountFetch;
}

export function WhatsNewGate() {
    const [queue, setQueue] = useState<Release[]>([]);
    // Following a link to a page defers the window for this user in this tab, so it
    // does not follow them there; nothing is answered or closed by it. sessionStorage
    // survives the gate remounting on navigation and clears with the tab, so the
    // window returns next visit.
    const { user } = useAuth();
    const deferKey = user ? `whatsnew.deferred:${user.id}` : null;
    const [, setDeferredNow] = useState(0);
    const deferred =
        deferKey !== null && typeof window !== "undefined" && window.sessionStorage.getItem(deferKey) === "1";
    const [confirming, setConfirming] = useState(false);
    const [wiping, setWiping] = useState(false);
    const [done, setDone] = useState<string[]>([]);
    const [wipeError, setWipeError] = useState<string | null>(null);
    // What a reopened release already has settled, so the window does not ask again.
    const [answered, setAnswered] = useState<Record<string, boolean>>({});
    const reopening = useRef(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const releases = await fetchPending();
                if (!cancelled) setQueue(releases);
            } catch {
                // Never block the app on this. Someone who came to listen to
                // music should not be stopped by a changelog that failed to load;
                // it stays pending and appears next time.
            }
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const reopen = async () => {
            if (reopening.current) return;
            reopening.current = true;
            try {
                const current = await api.get<{ release: Release; answers: Record<string, boolean>; done: string[] }>(
                    "/whats-new/current",
                );
                if (deferKey) window.sessionStorage.removeItem(deferKey);
                setDeferredNow((n) => n + 1);
                setAnswered(current.answers);
                setDone((d) => [...new Set([...d, ...current.done])]);
                // Older releases still unread stay ahead of it.
                setQueue((q) => (q.some((r) => r.version === current.release.version) ? q : [...q, current.release]));
            } catch {
                notify.error("Couldn't open what's new");
            } finally {
                reopening.current = false;
            }
        };
        window.addEventListener(OPEN_EVENT, reopen);
        return () => window.removeEventListener(OPEN_EVENT, reopen);
    }, [deferKey]);

    if (queue.length === 0 || deferred) return null;
    const wipe = queue.flatMap((r) => r.items).find((i) => i.kind === "action" && i.run === "wipeEnrichment");

    const runWipe = async () => {
        if (!wipe) return;
        setConfirming(false);
        setWiping(true);
        setWipeError(null);
        try {
            await api.wipeAndRerunEnrichment();
            setDone((d) => [...d, wipe.key]);
        } catch {
            setWipeError("Couldn't start it. Try again, or use Settings, under Library Enrichment.");
        } finally {
            setWiping(false);
        }
    };

    // Done closes every pending release in the queue, not just the heading's:
    // a window that shows two releases must record both closings.
    const dismissAll = async () => {
        for (const r of queue) await api.post(`/whats-new/${r.version}/dismiss`, {});
    };

    const defer = () => {
        if (!deferKey) return;
        window.sessionStorage.setItem(deferKey, "1");
        setDeferredNow((n) => n + 1);
    };

    return (
        <>
            <WhatsNewWindow
                releases={queue}
                answered={answered}
                onDismiss={dismissAll}
                onClose={() => { closeAll(); setQueue([]); }}
                onNavigate={defer}
                done={done}
                renderAction={(item) =>
                    item.key === "moods.mixes" || item.key === "moods.mixes.retired" ? (
                        // Rebuild / keep / save as playlist, or for a mix under a
                        // removed mood, save / remove. The server only sends these
                        // to users who have that kind of saved mix.
                        <MoodMixChoice onNavigate={defer} />
                    ) : item.run === "wipeEnrichment" ? (
                        <div className="flex flex-col gap-2">
                            {done.includes(item.key) ? (
                                <p className="text-sm text-success flex items-center gap-2" data-testid="wipe-started">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Wiped. Your library is running through the new engine in the background.
                                </p>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setConfirming(true)}
                                    disabled={wiping}
                                    data-testid="wipe-run"
                                    className="self-start min-h-11 py-2.5 px-4 rounded-lg bg-brand hover:bg-brand-hover text-black text-sm font-semibold flex items-center gap-2 transition-colors disabled:opacity-60"
                                >
                                    {wiping ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                    {wiping ? "Starting..." : item.cta}
                                </button>
                            )}
                            {wipeError && <p className="text-sm text-danger-light">{wipeError}</p>}
                        </div>
                    ) : null
                }
            />

            {confirming && wipe && wipe.kind === "action" && (
                <div data-nested-confirm="true">
                    <ConfirmDialog
                        isOpen={true}
                        onClose={() => setConfirming(false)}
                        onConfirm={runWipe}
                        title={wipe.confirmTitle ?? "Wipe and re-run enrichment?"}
                        message={wipe.confirmMessage ?? ""}
                        confirmText={wipe.confirmLabel ?? wipe.cta}
                        cancelText="Not now"
                        variant="warning"
                    />
                </div>
            )}
        </>
    );
}
