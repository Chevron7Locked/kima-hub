"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import type { ReleaseItem } from "./types";

type RefileItem = Extract<ReleaseItem, { kind: "action" }>;

/**
 * The re-file item's control, wherever a release is read: it asks first, queues the re-file (the server runs one at a
 * time, after any scan), then says where the result shows. When the server already reports it done, it says so instead. The same as Settings' "Re-file Albums by Tags".
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
            setError(err instanceof Error ? err.message : "Couldn't start it. Try again, or use Settings, under Library Enrichment.");
        } finally {
            setStarting(false);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            {done ? (
                <p className="text-sm text-success">
                    {started
                        ? "Re-filing albums. The result will show in your notifications."
                        : "Albums re-filed. You can run it again from Settings, under Library Enrichment."}
                </p>
            ) : (
                <Button variant="primary" onClick={() => setConfirming(true)} isLoading={starting} className="self-start">
                    {starting ? "Starting..." : item.cta}
                </Button>
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
