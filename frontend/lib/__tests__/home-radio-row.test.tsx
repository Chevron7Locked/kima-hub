/**
 * The home page's radio row shows its other stations whatever the mood station list is doing: while the list loads
 * the mood stations hold their place, and a list that failed shows a tile that asks for it again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const mood = { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/audio-controls-context", () => ({ useAudioControls: () => ({ playStation: vi.fn() }) }));
vi.mock("@/lib/features-context", () => ({ useFeatures: () => ({ vibeEmbeddings: true, loading: false }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useIsMobile: () => false, useIsTablet: () => false }));
vi.mock("@/hooks/useQueries", () => ({
    useLibraryGenresQuery: () => ({ data: { genres: [{ genre: "rock", count: 40 }] }, isLoading: false }),
    useLibraryDecadesQuery: () => ({ data: { decades: [{ decade: 1990, count: 30 }] }, isLoading: false }),
    useMoodStationsQuery: () => mood,
}));

import { LibraryRadioStations } from "@/features/home/components/LibraryRadioStations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(mood, { data: undefined, isLoading: false, isError: false, isFetching: false });
    mood.refetch.mockReset();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const titles = () => Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);

async function render() {
    await act(async () => root.render(<LibraryRadioStations />));
}

describe("the home radio row", () => {
    it("shows the other stations while the mood list loads, with the mood stations' places held", async () => {
        mood.isLoading = true;
        await render();
        expect(titles()).toEqual(["Shuffle All", "Workout", "Discovery", "Favorites", "rock", "90s"]);
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
    });

    it("shows the other stations and a tile that asks again when the mood list failed", async () => {
        mood.isError = true;
        await render();
        expect(titles()).toEqual(["Shuffle All", "Workout", "Discovery", "Favorites", "Mood stations", "rock", "90s"]);
        const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Mood stations"))!;
        await act(async () => retry.click());
        expect(mood.refetch).toHaveBeenCalledTimes(1);
    });

    it("puts the mood stations after Quick Start once the list is in", async () => {
        mood.data = { stations: [{ value: "calm", name: "Calm", description: "Calm, dreamy, low energy" }] };
        await render();
        expect(titles()).toEqual(["Shuffle All", "Workout", "Discovery", "Favorites", "Calm", "rock", "90s"]);
    });
});
