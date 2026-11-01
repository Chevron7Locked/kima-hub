/**
 * The home page draws at once. Each section waits on its own request and holds its place with card-sized blanks
 * until it arrives, so one slow request never keeps the rest of the page off the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

type Q = { data: unknown; isLoading: boolean };
const pending: Q = { data: undefined, isLoading: true };
const q = {
    listened: pending, added: pending, recommended: pending, mixes: pending, popular: pending,
    podcasts: pending, audiobooks: pending, browse: pending,
} as Record<string, Q>;

vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: (u: string) => u } }));
vi.mock("@/lib/notify", () => ({ notify: { error: vi.fn() } }));
vi.mock("@/features/home/components/LibraryRadioStations", () => ({
    LibraryRadioStations: () => <div data-testid="radio" />,
}));
vi.mock("@/components/MoodMixer", () => ({ MoodMixer: () => null }));
vi.mock("@/hooks/useQueries", () => ({
    useRecentlyListenedQuery: () => q.listened,
    useRecentlyAddedQuery: () => q.added,
    useRecommendationsQuery: () => q.recommended,
    useMixesQuery: () => q.mixes,
    usePopularArtistsQuery: () => q.popular,
    usePodcastChartQuery: () => q.podcasts,
    useAudiobooksQuery: () => q.audiobooks,
    useBrowseAllQuery: () => q.browse,
    useRefreshMixesMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import HomePage from "@/app/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const k of Object.keys(q)) q[k] = pending;
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const render = () => act(async () => root.render(<HomePage />));
const headings = () => Array.from(container.querySelectorAll("h2")).map((h) => h.textContent);
const section = (key: string) => container.querySelector(`[data-tv-section="${key}"]`);
const blanks = (key: string) => section(key)?.querySelectorAll("[data-placeholder-card]").length ?? 0;

describe("the home page while its requests are out", () => {
    it("draws the greeting and every section's place with no full-page loading screen", async () => {
        await render();
        expect(container.textContent).not.toContain("Loading...");
        expect(container.querySelector("h1")?.textContent).toMatch(/Good (morning|afternoon|evening)/);
        expect(headings()).toEqual([
            "Library Radio", "Continue Listening", "Recently Added", "Made For You", "Recommended",
            "Popular Artists", "Featured Playlists", "Popular Podcasts", "Audiobooks",
        ]);
        for (const key of ["continue-listening", "recently-added", "made-for-you", "recommended", "popular-artists", "popular-podcasts", "audiobooks"]) {
            expect(blanks(key)).toBeGreaterThan(0);
        }
    });

    it("shows the sections that arrived while a slow one is still out", async () => {
        q.added = { isLoading: false, data: { artists: [{ id: "a1", name: "Boards" }] } };
        q.mixes = { isLoading: false, data: [{ id: "m1", name: "Mix One", trackCount: 3, coverUrls: [] }] };
        await render();
        expect(container.textContent).toContain("Boards");
        expect(container.textContent).toContain("Mix One");
        expect(blanks("recently-added")).toBe(0);
        expect(blanks("made-for-you")).toBe(0);
        expect(blanks("recommended")).toBeGreaterThan(0);
        expect(blanks("audiobooks")).toBeGreaterThan(0);
    });

    it("drops a section whose request finished empty or failed, as before", async () => {
        q.recommended = { isLoading: false, data: { artists: [] } };
        q.audiobooks = { isLoading: false, data: undefined };
        await render();
        expect(section("recommended")).toBeNull();
        expect(section("audiobooks")).toBeNull();
        expect(section("popular-artists")).not.toBeNull();
    });

    it("swaps a section's blanks for its content when its request lands", async () => {
        await render();
        expect(blanks("recently-added")).toBeGreaterThan(0);
        q.added = { isLoading: false, data: { artists: [{ id: "a1", name: "Boards" }] } };
        await render();
        expect(blanks("recently-added")).toBe(0);
        expect(section("recently-added")?.textContent).toContain("Boards");
    });
});
