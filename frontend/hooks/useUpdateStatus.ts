"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { notify } from "@/lib/notify";

/**
 * Whether a newer server release is out, for the amber dot on the version
 * chip. The server checks GitHub once a day; this only reads that answer.
 * The tray ping fires once per release per browser.
 */

const NOTIFIED_FOR_KEY = "kima-update-notified-for";

// Two mounted chips must not both fire the notification.
let notifyingFor: string | null = null;

function readNotifiedFor(): string | null {
    try {
        return localStorage.getItem(NOTIFIED_FOR_KEY);
    } catch {
        return null;
    }
}

function markNotifiedFor(version: string) {
    try {
        localStorage.setItem(NOTIFIED_FOR_KEY, version);
    } catch {
        // A private-mode browser just gets the ping again next load.
    }
}

export function useUpdateStatus() {
    const query = useQuery({
        queryKey: ["update-status"],
        queryFn: () => api.getUpdateStatus(),
        staleTime: 6 * 60 * 60 * 1000,
        refetchInterval: 12 * 60 * 60 * 1000,
        retry: 1,
    });

    const status = query.data;

    useEffect(() => {
        if (!status?.hasUpdate || !status.latest) return;
        if (notifyingFor === status.latest || readNotifiedFor() === status.latest) return;
        notifyingFor = status.latest;
        markNotifiedFor(status.latest);
        notify.info(`update available: v${status.latest}`, {
            message: `this server runs v${status.current}. pull the newest release to update.`,
        });
    }, [status]);

    return status ?? null;
}
