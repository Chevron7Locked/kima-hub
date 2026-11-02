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
const getRadioCovers = vi.fn();
vi.mock("@/lib/api", () => ({
    api: { get: (url: string) => get(url), getRadioCovers: (...args: unknown[]) => getRadioCovers(...args), getCoverArtUrl: (id: string) => `/cover/${id}` },
}));
vi.mock("@/lib/audio-controls-context", () => ({ useAudioControls: () => ({ playStation: vi.fn() }) }));
vi.mock("@/lib/features-context", () => ({ useFeatures: () => ({ vibeEmbeddings: true, loading: false }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useIsMobile: () => false, useIsTablet: () => false }));
vi.mock("@/hooks/useQueries", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/hooks/useQueries")>()),
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
    getRadioCovers.mockReset();
    getRadioCovers.mockResolvedValue({ covers: [] });
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

    it("shows each station's cover from the one reply, and no line that just says radio", async () => {
        getRadioCovers.mockResolvedValue({
            covers: [
                { type: "all", value: null, cover: "a" },
                { type: "workout", value: null, cover: null },
                { type: "genre", value: "rock", cover: "r" },
            ],
        });
        mood.data = { stations: [] };
        await render();
        const tile = (name: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(name))!;
        const srcs = (name: string) => Array.from(tile(name).querySelectorAll("img")).map((img) => new URL(img.getAttribute("src")!, "http://x").pathname);
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(srcs("Shuffle All")).toEqual(["/cover/a"]);
        });
        expect(srcs("rock")).toEqual(["/cover/r"]);
        // A cover arrives after its tile is on screen; a lazy image there waited up to 3 s for the browser to fetch it.
        expect(tile("Shuffle All").querySelector("img")!.getAttribute("loading")).toBe("eager");
        // A station with no cover is a fade of its own colour (Workout's red), not a dark tile.
        const workout = tile("Workout");
        expect(workout.querySelector("img")).toBeNull();
        expect(Array.from(workout.querySelectorAll<HTMLElement>("[aria-hidden]")).map((el) => el.style.background).join(" ")).toMatch(/#ef44448c|239, 68, 68, 0\.55/i);
        const texts = Array.from(container.querySelectorAll("button *")).map((el) => el.textContent?.trim().toLowerCase());
        expect(texts).not.toContain("radio");
    });

    it("asks for every tile's cover in one request, and never calls a station for one", async () => {
        mood.data = { stations: [{ value: "calm", name: "Calm", description: "" }] };
        await render();
        await act(async () => {});
        expect(getRadioCovers).toHaveBeenCalledTimes(1);
        const [stations] = getRadioCovers.mock.calls[0];
        expect(stations).toEqual([
            { type: "all" },
            { type: "workout" },
            { type: "discovery" },
            { type: "favorites" },
            { type: "mood", value: "calm" },
            { type: "genre", value: "rock" },
            { type: "decade", value: "1990" },
        ]);
        expect(get).not.toHaveBeenCalled();
    });

    it("waits for the mood list before asking, so the row's covers are one request", async () => {
        mood.isLoading = true;
        await render();
        await act(async () => {});
        expect(getRadioCovers).not.toHaveBeenCalled();
    });

    it("keeps the tiles' covers while a changed station list waits for its answer", async () => {
        getRadioCovers.mockResolvedValueOnce({ covers: [{ type: "all", value: null, cover: "a" }] });
        // The second list (the mood stations arrive) is asked for and never answered during the test.
        getRadioCovers.mockImplementationOnce(() => new Promise(() => {}));
        mood.data = { stations: [] };
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const tree = () => (
            <QueryClientProvider client={client}>
                <LibraryRadioStations />
            </QueryClientProvider>
        );
        await act(async () => root.render(tree()));
        const shuffle = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Shuffle All"))!;
        const srcs = () => Array.from(shuffle().querySelectorAll("img")).map((img) => new URL(img.getAttribute("src")!, "http://x").pathname);
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(srcs()).toEqual(["/cover/a"]);
        });
        mood.data = { stations: [{ value: "calm", name: "Calm", description: "" }] };
        await act(async () => root.render(tree()));
        await vi.waitFor(() => expect(getRadioCovers).toHaveBeenCalledTimes(2));
        expect(titles()).toContain("Calm");
        expect(srcs()).toEqual(["/cover/a"]);
    });
});
