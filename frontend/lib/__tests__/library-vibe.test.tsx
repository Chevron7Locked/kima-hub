/**
 * The collection page's mood picture comes from the server's small summary, not the whole vibe map:
 * useLibraryVibe turns the reply into the shares list and the two Maps the page and cards read, shows
 * nothing while the first layout is pending, and never asks for the map.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getMoodSummary = vi.fn();
const getVibeMap = vi.fn();
vi.mock("@/lib/api", () => ({
    api: { getMoodSummary: () => getMoodSummary(), getVibeMap: () => getVibeMap() },
}));

import { useLibraryVibe } from "@/features/library/useLibraryVibe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root;
const probe = {} as { seen: ReturnType<typeof useLibraryVibe> };

function Probe() {
    const result = useLibraryVibe();
    useEffect(() => {
        probe.seen = result;
    });
    return null;
}

async function mount() {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    // The query resolves over a few turns of the event loop.
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
    getMoodSummary.mockReset();
    getVibeMap.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(document.createElement("div"));
});

afterEach(() => {
    act(() => root.unmount());
    client.clear();
});

describe("useLibraryVibe", () => {
    it("maps the server's summary into the shares and the album and artist Maps", async () => {
        getMoodSummary.mockResolvedValue({
            shares: [
                { key: "moodRelaxed", fraction: 0.75 },
                { key: "neutral", fraction: 0.25 },
            ],
            albums: { "al-1": "moodRelaxed", "al-2": "moodSad" },
            artists: { "ar-1": "moodRelaxed" },
        });
        await mount();
        expect(probe.seen.shares).toEqual([
            { key: "moodRelaxed", fraction: 0.75 },
            { key: "neutral", fraction: 0.25 },
        ]);
        expect(probe.seen.albumMood).toBeInstanceOf(Map);
        expect(probe.seen.albumMood.get("al-1")).toBe("moodRelaxed");
        expect(probe.seen.albumMood.get("al-2")).toBe("moodSad");
        expect(probe.seen.albumMood.has("al-3")).toBe(false);
        expect(probe.seen.artistMood.get("ar-1")).toBe("moodRelaxed");
        expect(getVibeMap).not.toHaveBeenCalled();
    });

    it("shows a quiet band and marks no card while the layout is pending or the reply has not come", async () => {
        getMoodSummary.mockResolvedValue({ computing: true });
        await mount();
        expect(probe.seen.shares).toEqual([]);
        expect(probe.seen.albumMood.size).toBe(0);
        expect(probe.seen.artistMood.size).toBe(0);
    });

    it("keeps the same Maps between renders when nothing changed", async () => {
        getMoodSummary.mockResolvedValue({ shares: [], albums: { a: "moodHappy" }, artists: {} });
        await mount();
        const first = probe.seen.albumMood;
        expect(first.get("a")).toBe("moodHappy");
        await mount();
        expect(probe.seen.albumMood).toBe(first);
    });
});
