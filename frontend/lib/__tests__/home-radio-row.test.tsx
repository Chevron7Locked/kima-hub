/**
 * The home page's radio row shows its other stations whatever the mood station list is doing: while the list loads
 * the mood stations hold their place, and a list that failed shows a tile that asks for it again. Each station shows
 * the cover of a song it would play, and no "radio" line repeating the row's heading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mood = { data: undefined as unknown, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };

const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (url: string) => get(url), getCoverArtUrl: (id: string) => `/cover/${id}` } }));
vi.mock("@/lib/audio-controls-context", () => ({ useAudioControls: () => ({ playStation: vi.fn() }) }));
vi.mock("@/lib/features-context", () => ({ useFeatures: () => ({ vibeEmbeddings: true, loading: false }) }));
// The test page has no layout, so nothing ever scrolls into view: every tile counts as on screen.
vi.mock("@/hooks/useInView", () => ({ useInView: () => ({ ref: { current: null }, shown: true }) }));
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
    get.mockReset();
    get.mockResolvedValue({ tracks: [] });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const titles = () => Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);

async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
        root.render(
            <QueryClientProvider client={client}>
                <LibraryRadioStations />
            </QueryClientProvider>,
        ),
    );
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

    it("shows each station's cover from a song it would play, and no line that just says radio", async () => {
        get.mockImplementation(async (url: string) =>
            url.includes("type=all")
                ? { tracks: [{ album: {} }, { album: { coverArt: "a" } }, { album: { coverArt: "b" } }] }
                : { tracks: [] },
        );
        mood.data = { stations: [] };
        await render();
        const shuffle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Shuffle All"))!;
        const srcs = () => Array.from(shuffle.querySelectorAll("img")).map((img) => new URL(img.getAttribute("src")!, "http://x").pathname);
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(srcs()).toEqual(["/cover/a"]);
        });
        expect(get).toHaveBeenCalledWith(expect.stringContaining("/library/radio?type=all&limit=5"));
        // A station with no cover is a fade of its own colour (Workout's red), not a dark tile.
        const workout = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Workout"))!;
        expect(workout.querySelector("img")).toBeNull();
        expect(Array.from(workout.querySelectorAll<HTMLElement>("[aria-hidden]")).map((el) => el.style.background).join(" ")).toMatch(/#ef44448c|239, 68, 68, 0\.55/i);
        const texts = Array.from(container.querySelectorAll("button *")).map((el) => el.textContent?.trim().toLowerCase());
        expect(texts).not.toContain("radio");
    });

    it("asks for at most four stations' covers at once", async () => {
        const pending: (() => void)[] = [];
        get.mockImplementation(() => new Promise((done) => pending.push(() => done({ tracks: [] }))));
        mood.data = { stations: [] };
        await render();
        await act(async () => {});
        expect(get).toHaveBeenCalledTimes(4);
        await act(async () => pending.shift()!());
        await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(5));
        // Let every request finish, so the next test starts with none in flight.
        while (get.mock.calls.length < 6 || pending.length) {
            await act(async () => pending.shift()?.());
        }
        expect(get).toHaveBeenCalledTimes(6);
    });
});
