/**
 * The Discover page leaves its spinner as soon as the playlist and settings have arrived: both are set before
 * `loading` turns false, so there is nothing to wait out after them.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api", () => ({
    api: {
        getDiscoverBatchStatus: vi.fn(async () => ({ active: false, status: null })),
        getCurrentDiscoverWeekly: vi.fn(async () => ({ tracks: [], totalCount: 0 })),
        getDiscoverConfig: vi.fn(async () => ({ playlistSize: 10 })),
    },
}));

import { useDiscoverData } from "@/features/discover/hooks/useDiscoverData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let seen: ReturnType<typeof useDiscoverData> | null = null;

function Probe() {
    const data = useDiscoverData();
    useEffect(() => {
        seen = data;
    });
    return null;
}

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    seen = null;
});

it("stops loading once the playlist and settings are in, with no wait after them", async () => {
    await act(async () => {
        root.render(
            <QueryClientProvider client={new QueryClient()}>
                <Probe />
            </QueryClientProvider>,
        );
    });
    // Let the requests resolve, but no timer run.
    await act(async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(seen?.playlist).not.toBeNull();
    expect(seen?.config).toEqual({ playlistSize: 10 });
    expect(seen?.loading).toBe(false);
});
