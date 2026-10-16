"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { refreshOpenCount } from "./useVersionChip";
import type { ReleaseItem } from "./types";

type WipeItem = Extract<ReleaseItem, { kind: "action" }>;

// The request in flight, shared by every copy of the control: one closed and opened again while it runs shows it
// running instead of offering a second wipe, and learns how it ended. It never rejects: true when the wipe started.
let inFlight: Promise<boolean> | null = null;
const FAILED = "Couldn't start it. Try again, or use Settings, under Library Enrichment.";

/**
 * The wipe-and-re-run item's control, wherever a release is read: it asks first, starts the run, then says it is
 * running. The confirm is a dialog of its own, opened after the window, so Escape closes it before the window.
 */
export function WipeAction({ item, done, onDone }: { item: WipeItem; done: boolean; onDone: () => void }) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);
    const [starting, setStarting] = useState(() => inFlight !== null);
    const [error, setError] = useState<string | null>(null);

    // Opened while an earlier copy's request runs: wait for it here too, and say so if it failed.
    useEffect(() => {
        let mounted = true;
        inFlight?.then((started) => {
            if (!mounted) return;
            setStarting(false);
            if (!started) setError(FAILED);
        });
        return () => {
            mounted = false;
        };
    }, []);

    const run = async () => {
        if (inFlight) return;
        setConfirming(false);
        setStarting(true);
        setError(null);
        const request = api.wipeAndRerunEnrichment().then(
            () => true,
            () => false,
        );
        inFlight = request;
        const started = await request;
        inFlight = null;
        setStarting(false);
        if (started) {
            onDone();
            refreshOpenCount(queryClient);
        } else {
            setError(FAILED);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            {done ? (
                <p className="text-sm text-success flex items-center gap-2" data-testid="wipe-started">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Wiped. Your library is running through the engine in the background.
                </p>
            ) : (
                <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    disabled={starting}
                    data-testid="wipe-run"
                    className="self-start min-h-11 py-2.5 px-4 rounded-lg bg-brand hover:bg-brand-hover text-black text-sm font-semibold flex items-center gap-2 transition-colors disabled:opacity-60"
                >
                    {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {starting ? "Starting..." : item.cta}
                </button>
            )}
            {error && <p className="text-sm text-danger-light">{error}</p>}
            {confirming && (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setConfirming(false)}
                    onConfirm={run}
                    title={item.confirmTitle ?? "Wipe and re-run enrichment?"}
                    message={item.confirmMessage ?? ""}
                    confirmText={item.confirmLabel ?? item.cta}
                    cancelText="Not now"
                    variant="warning"
                />
            )}
        </div>
    );
}
