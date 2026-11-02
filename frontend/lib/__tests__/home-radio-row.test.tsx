/**
 * The home page's radio row draws its tiles once, from one reply that names the stations and carries each one's cover,
 * so the tiles rise with their covers like every other row's cards. Until the reply is in, the row holds its places;
 * a reply that failed shows a tile that asks again. No tile repeats the row's heading with a "radio" line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const get = vi.fn();
const getRadioRow = vi.fn();
vi.mock("@/lib/api", () => ({
    api: { get: (url: string) => get(url), getRadioRow: (...args: unknown[]) => getRadioRow(...args), getCoverArtUrl: (id: string) => `/cover/${id}` },
}));
vi.mock("@/lib/audio-controls-context", () => ({ useAudioControls: () => ({ playStation: vi.fn() }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useIsMobile: () => false, useIsTablet: () => false }));

import { LibraryRadioStations } from "@/features/home/components/LibraryRadioStations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = [
    { type: "all", value: null, cover: "a" },
    { type: "workout", value: null, cover: null },
    { type: "discovery", value: null, cover: "d" },
    { type: "favorites", value: null, cover: "f" },
    { type: "mood", value: "calm", name: "Calm", description: "Calm, dreamy, low energy", cover: "c" },
    { type: "genre", value: "rock", count: 40, cover: "r" },
    { type: "decade", value: "1990", count: 30, cover: "n" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    get.mockReset();
    getRadioRow.mockReset();
    getRadioRow.mockResolvedValue({ stations: ROW });
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const titles = () => Array.from(container.querySelectorAll("h3")).map((h) => h.textContent);
const tile = (name: string) => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(name))!;
const srcs = (name: string) => Array.from(tile(name).querySelectorAll("img")).map((img) => new URL(img.getAttribute("src")!, "http://x").pathname);

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
    it("holds its places and draws no tile until the reply is in", async () => {
        getRadioRow.mockImplementation(() => new Promise(() => {}));
        await render();
        expect(titles()).toEqual([]);
        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    });

    it("draws every tile with its cover at once, in the server's order, from one request", async () => {
        await render();
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(titles()).toEqual(["Shuffle All", "Workout", "Discovery", "Favorites", "Calm", "rock", "90s"]);
        });
        // The covers are in place the moment the tiles are.
        expect(srcs("Shuffle All")).toEqual(["/cover/a"]);
        expect(srcs("Calm")).toEqual(["/cover/c"]);
        expect(srcs("rock")).toEqual(["/cover/r"]);
        expect(srcs("90s")).toEqual(["/cover/n"]);
        expect(getRadioRow).toHaveBeenCalledTimes(1);
        expect(getRadioRow.mock.calls[0][0]).toBe("home");
        expect(get).not.toHaveBeenCalled();
    });

    it("shows only the quick stations the server lists", async () => {
        getRadioRow.mockResolvedValue({ stations: ROW.filter((s) => s.type !== "workout" && s.type !== "mood") });
        await render();
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(titles()).toEqual(["Shuffle All", "Discovery", "Favorites", "rock", "90s"]);
        });
    });

    it("a station with no cover is a fade of its own colour, and no tile says just radio", async () => {
        await render();
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(titles()).toContain("Workout");
        });
        const workout = tile("Workout");
        expect(workout.querySelector("img")).toBeNull();
        expect(Array.from(workout.querySelectorAll<HTMLElement>("[aria-hidden]")).map((el) => el.style.background).join(" ")).toMatch(/#ef44448c|239, 68, 68, 0\.55/i);
        const texts = Array.from(container.querySelectorAll("button *")).map((el) => el.textContent?.trim().toLowerCase());
        expect(texts).not.toContain("radio");
    });

    it("loads the covers at once, not lazily", async () => {
        await render();
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(titles()).toContain("Shuffle All");
        });
        expect(tile("Shuffle All").querySelector("img")!.getAttribute("loading")).toBe("eager");
    });

    it("a reply that failed shows a tile that asks again", async () => {
        getRadioRow.mockRejectedValueOnce(new Error("offline"));
        await render();
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(titles()).toEqual(["Radio stations"]);
        });
        await act(async () => tile("Radio stations").click());
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(titles()).toContain("Shuffle All");
        });
        expect(getRadioRow).toHaveBeenCalledTimes(2);
    });
});
