"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";

const scanEnded = (status?: string) => status === "completed" || status === "failed";

/**
 * The "sync library" action every navigation surface offers: starts a library scan and reports `syncing` until it
 * ends. SSE events update the scan's state as they arrive; it is also read every 2 s until the scan ends, so a
 * missed event cannot leave a button spinning. Resolves true when the scan started.
 */
export function useLibrarySync() {
    const queryClient = useQueryClient();
    const [scanJobId, setScanJobId] = useState<string | null>(null);

    const { data: scanStatus } = useQuery<{ status: string; progress: number; jobId: string; error?: string } | null>({
        queryKey: ["scan-status", scanJobId],
        queryFn: async () => {
            try {
                return { ...(await api.getScanStatus(scanJobId!)), jobId: scanJobId! };
            } catch (error) {
                if ((error as { status?: number }).status === 404) return { status: "completed", progress: 100, jobId: scanJobId! };
                throw error;
            }
        },
        enabled: !!scanJobId,
        refetchInterval: (query) => (scanEnded(query.state.data?.status) ? false : 2000),
    });

    const syncing = !!scanJobId && !scanEnded(scanStatus?.status);

    if (scanStatus && scanJobId && scanEnded(scanStatus.status)) {
        setScanJobId(null);
    }

    const sync = async (): Promise<boolean> => {
        if (syncing) return false;
        try {
            const response = await api.scanLibrary();
            // Every manual scan has the same job id; the last scan's "completed" must not stand in for this one.
            queryClient.removeQueries({ queryKey: ["scan-status", response.jobId] });
            setScanJobId(response.jobId);
            return true;
        } catch (error) {
            // A refused scan never starts, so nothing else reports it.
            const message = error instanceof Error ? error.message : String(error);
            notify.error(
                /403|forbidden|admin/i.test(message)
                    ? "only an admin can scan the library"
                    : "couldn't start the library scan"
            );
            return false;
        }
    };

    return { sync, syncing };
}
