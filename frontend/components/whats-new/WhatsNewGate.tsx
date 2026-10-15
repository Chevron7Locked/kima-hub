"use client";

/**
 * Shows every release the user has not closed in one window, the newest note first and every pending item oldest
 * first. The version number beside the logo opens it while something is unread, and the changelog otherwise. The
 * server decides what is pending; nothing is recorded locally, so a second device still asks.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";
import { useAuth } from "@/lib/auth-context";
import { WhatsNewWindow } from "./WhatsNewWindow";
import { WipeAction } from "./WipeAction";
import type { Release } from "./types";
import { MoodMixChoice } from "./MoodMixChoice";
import { useQueryClient } from "@tanstack/react-query";
import { refreshOpenCount } from "./useVersionChip";

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

/** Brings the window up with the current release and its answers so far: unread news, or a window put off by a link. */
function openWhatsNew(): void {
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
    const [done, setDone] = useState<string[]>([]);
    // Answers the current release already has, so the window shows them instead of asking again.
    const [answered, setAnswered] = useState<Record<string, boolean>>({});
    const reopening = useRef(false);
    const queryClient = useQueryClient();

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
                onClose={() => { closeAll(); setQueue([]); refreshOpenCount(queryClient); }}
                onNavigate={defer}
                done={done}
                renderAction={(item) =>
                    item.key === "moods.mixes" || item.key === "moods.mixes.retired" ? (
                        // Rebuild / keep / save as playlist, or for a mix under a
                        // removed mood, save / remove. The server only sends these
                        // to users who have that kind of saved mix.
                        <MoodMixChoice onNavigate={defer} />
                    ) : item.run === "wipeEnrichment" ? (
                        <WipeAction item={item} done={done.includes(item.key)} onDone={() => setDone((d) => [...d, item.key])} />
                    ) : null
                }
            />

        </>
    );
}
