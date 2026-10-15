"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useUpdateStatus } from "@/hooks/useUpdateStatus";
import { APP_VERSION } from "@/lib/version";

const OPEN_COUNT = ["whats-new", "open-count"] as const;

/** After anything that can settle a release's open item, the version chip counts again. */
export function refreshOpenCount(queryClient: QueryClient): void {
    void queryClient.invalidateQueries({ queryKey: OPEN_COUNT });
}

/** What the version chip shows, in the top bar and the phone menu alike. */
export function useVersionChip() {
    const { user } = useAuth();
    const updateStatus = useUpdateStatus();
    // Open requirements the server cannot yet see done; read again on returning to the tab, since some (a wipe
    // running through the library) finish on the server.
    const { data: openCount = 0 } = useQuery({
        queryKey: [...OPEN_COUNT, user?.id ?? null],
        queryFn: () => api.get<{ count: number }>("/whats-new/open").then((r) => r.count),
        enabled: !!user,
        staleTime: 60_000,
        refetchOnWindowFocus: true,
    });
    const update = updateStatus?.hasUpdate && updateStatus.latest ? updateStatus.latest : null;
    return {
        openCount,
        update,
        label: `what's new in v${APP_VERSION}${update ? ` — update available: v${update}` : ""}${openCount > 0 ? ` — ${openCount} open` : ""}`,
        title: update ? `update available: v${update}` : `what's new in v${APP_VERSION}`,
    };
}
