"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import type { ReleaseItem } from "./types";

type RefileItem = Extract<ReleaseItem, { kind: "action" }>;

/**
 * The re-file item's control, wherever a release is read: a button that is always there, since a re-file can be run
 * again any time. It asks first, queues the re-file (the server runs one at a time, after any scan), then says where
 * the result shows. The same as the re-file row in Settings, under Library.
 */
export function RefileAction({ item, done, onDone }: { item: RefileItem; done: boolean; onDone: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const [starting, setStarting] = useState(false);
    // Started by this click: the server's own "done" (an earlier run) is told apart from a re-file now queued.
    const [started, setStarted] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async () => {
        setConfirming(false);
        setStarting(true);
        setError(null);
        try {
            await api.refileAlbums();
            setStarted(true);
            onDone();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't start it. Try again, or use Settings, under Library.");
        } finally {
            setStarting(false);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <Button variant="primary" onClick={() => setConfirming(true)} isLoading={starting} className="self-start">
                {starting ? "Starting..." : item.cta}
            </Button>
            {started ? (
                <p className="text-sm text-success">Re-filing albums. The result will show in your notifications.</p>
            ) : (
                done && <p className="text-sm text-[var(--text-secondary)]">Albums were re-filed before. Running it again is safe.</p>
            )}
            {error && <p className="text-sm text-danger-light">{error}</p>}
            {confirming && (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setConfirming(false)}
                    onConfirm={run}
                    title={item.confirmTitle ?? item.title}
                    message={item.confirmMessage ?? ""}
                    confirmText={item.confirmLabel ?? item.cta}
                    cancelText="Not now"
                    variant="warning"
                />
            )}
        </div>
    );
}
