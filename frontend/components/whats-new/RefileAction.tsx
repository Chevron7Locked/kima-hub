"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import type { ReleaseItem } from "./types";

type RefileItem = Extract<ReleaseItem, { kind: "action" }>;

/**
 * The re-file item's control, wherever a release is read: it asks first, queues the re-file (the server runs one at a
 * time, after any scan), then says where the result shows. The same as Settings' "Re-file Albums by Tags".
 */
export function RefileAction({ item, done, onDone }: { item: RefileItem; done: boolean; onDone: () => void }) {
    const [confirming, setConfirming] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async () => {
        setConfirming(false);
        setStarting(true);
        setError(null);
        try {
            await api.refileAlbums();
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
                <p className="text-sm text-success">Re-filing albums. The result will show in your notifications.</p>
            ) : (
                <Button variant="primary" onClick={() => setConfirming(true)} disabled={starting} className="self-start">
                    {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
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
