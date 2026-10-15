"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { refreshOpenCount } from "./useVersionChip";
import type { ReleaseItem } from "./types";

type WipeItem = Extract<ReleaseItem, { kind: "action" }>;

/**
 * The wipe-and-re-run item's control, wherever a release is read: it asks first, starts the run, then says it is
 * running. The confirm sits in a nested-confirm wrapper, so Escape closes it before the window around it.
 */
export function WipeAction({ item, done, onDone }: { item: WipeItem; done: boolean; onDone: () => void }) {
    const queryClient = useQueryClient();
    const [confirming, setConfirming] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async () => {
        setConfirming(false);
        setStarting(true);
        setError(null);
        try {
            await api.wipeAndRerunEnrichment();
            onDone();
            refreshOpenCount(queryClient);
        } catch {
            setError("Couldn't start it. Try again, or use Settings, under Library Enrichment.");
        } finally {
            setStarting(false);
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
                <div data-nested-confirm="true">
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
                </div>
            )}
        </div>
    );
}
