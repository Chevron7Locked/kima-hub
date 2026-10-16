/**
 * Every control that closes on Escape marks the key as used, so page-wide Escape handlers (TV Back, the vibe page's
 * undo) leave it alone; a closed control leaves Escape unmarked for them. Real components and real key events, sent
 * where the browser would send them; only the server and the screen-size and TV checks are stand-ins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
    usePathname: () => "/",
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
    useParams: () => ({ id: "p-1" }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: "u-1", role: "admin" } }) }));
vi.mock("@/lib/features-context", () => ({ useFeatures: () => ({ audiobookshelfEnabled: false }) }));
let mobile = false;
vi.mock("@/hooks/useMediaQuery", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/hooks/useMediaQuery")>()),
    useIsMobile: () => mobile,
    useIsTablet: () => false,
}));
vi.mock("@/lib/tv-utils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/tv-utils")>()),
    useIsTV: () => true,
}));
// The phone menu itself is not under test here, only the Sidebar's Escape while it is open.
vi.mock("@/components/layout/MobileSidebar", () => ({
    MobileSidebar: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-mobile-menu /> : null),
}));
vi.mock("@/hooks/useQueries", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/hooks/useQueries")>()),
    useDiscoverSearchQuery: () => ({ data: { results: [{ id: 1, name: "a show" }] }, isFetching: false }),
    useSearchQuery: () => ({ data: { episodes: [] }, isFetching: false }),
}));
vi.mock("@/lib/api", () => ({
    api: {
        // The listening clock's hour: what was played then.
        get: vi.fn(async () => ({ weekday: 1, hour: 12, listens: 1, tracks: [], artists: [], lastAt: null })),
        post: vi.fn(async () => ({})),
        getPlaylists: vi.fn(async () => []),
    },
    getApiBaseUrl: () => "",
}));

import { WhatsNewWindow } from "@/components/whats-new/WhatsNewWindow";
import { Sidebar } from "@/components/layout/Sidebar";
import { RefinePanel } from "@/features/library/components/RefinePanel";
import { TVSearchInput } from "@/features/search/components/TVSearchInput";
import { PodcastSearch } from "@/features/podcast/components/PodcastSearch";
import { ListeningClock } from "@/features/stats/components/ListeningClock";
import { Shortcuts } from "@/features/stats/components/Shortcuts";
import type { ListeningStats } from "@/features/stats/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

async function show(node: React.ReactNode) {
    await act(async () => root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>));
}

/** Presses Escape where the browser would deliver it: the focused element, or the page. */
async function escapeAt(target: EventTarget = document.body): Promise<KeyboardEvent> {
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(escape));
    return escape;
}

async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

const find = <T extends Element>(selector: string) => host.querySelector<T>(selector);

beforeEach(() => {
    mobile = false;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("a control closed by Escape marks the key as used", () => {
    it("the What's new window", async () => {
        const onDismiss = vi.fn(async () => undefined);
        await show(
            <WhatsNewWindow
                releases={[{ version: "1.12.0", title: "Kima 1.12", summary: "s", date: "2026-10-13", items: [] }]}
                onClose={() => undefined}
                onDismiss={onDismiss}
            />,
        );

        const escape = await escapeAt();

        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(escape.defaultPrevented).toBe(true);
    });

    it("the sidebar's new-playlist box", async () => {
        await show(<Sidebar />);
        await act(async () => find<HTMLButtonElement>('button[aria-label="Create playlist"]')!.click());
        const input = find<HTMLInputElement>('input[placeholder="Playlist name"]')!;

        const escape = await escapeAt(input);

        expect(find('input[placeholder="Playlist name"]')).toBeNull();
        expect(escape.defaultPrevented).toBe(true);
    });

    it("the sidebar's menu on a phone", async () => {
        mobile = true;
        await show(<Sidebar />);
        await act(async () => window.dispatchEvent(new Event("toggle-mobile-menu")));
        expect(find("[data-mobile-menu]")).not.toBeNull();

        const escape = await escapeAt();

        expect(find("[data-mobile-menu]")).toBeNull();
        expect(escape.defaultPrevented).toBe(true);
    });

    it("the library's filter panel", async () => {
        await show(
            <RefinePanel
                activeTab="albums"
                filter="all"
                sortBy="name"
                itemsPerPage={50}
                onFilterChange={() => undefined}
                onSortChange={() => undefined}
                onItemsPerPageChange={() => undefined}
            />,
        );
        const button = find<HTMLButtonElement>("button[aria-expanded]")!;
        await act(async () => button.click());
        expect(button.getAttribute("aria-expanded")).toBe("true");

        const escape = await escapeAt();

        expect(button.getAttribute("aria-expanded")).toBe("false");
        expect(escape.defaultPrevented).toBe(true);
    });

    it("the TV search box, which Escape leaves", async () => {
        await show(<TVSearchInput onSearch={() => undefined} />);
        const input = find<HTMLInputElement>("input")!;
        await act(async () => input.focus());

        const escape = await escapeAt(input);

        expect(document.activeElement).not.toBe(input);
        expect(escape.defaultPrevented).toBe(true);
    });

    it("podcast search results, and not while they are closed", async () => {
        await show(<PodcastSearch />);
        const input = find<HTMLInputElement>('input[aria-label="search shows and episodes"]')!;
        expect((await escapeAt(input)).defaultPrevented, "Escape with the results closed was marked as used").toBe(false);

        await type(input, "daddies");
        const results = () => find('[aria-label="search results"]');
        expect(results()).not.toBeNull();

        const escape = await escapeAt(input);

        expect(results()).toBeNull();
        expect(escape.defaultPrevented).toBe(true);
    });

    it("an hour opened on the listening clock", async () => {
        const clock = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 1));
        const listening = { plays: 168, clock, peak: { weekday: 1, hour: 12, plays: 1 } } as unknown as ListeningStats;
        await show(<ListeningClock listening={listening} />);
        const cell = find<HTMLButtonElement>('button[data-cell="1-12"]')!;
        await act(async () => cell.click());
        expect(cell.getAttribute("aria-pressed")).toBe("true");

        const escape = await escapeAt();

        expect(cell.getAttribute("aria-pressed")).toBe("false");
        expect(escape.defaultPrevented).toBe(true);
    });

    it("the stats page's shortcut list, and not while it is closed", async () => {
        await show(<Shortcuts chapters={[{ id: "a", label: "a" }]} onJump={() => undefined} />);
        expect((await escapeAt()).defaultPrevented, "Escape with the list closed was marked as used").toBe(false);

        await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true })));
        expect(find('[role="dialog"]')).not.toBeNull();

        const escape = await escapeAt();

        expect(find('[role="dialog"]')).toBeNull();
        expect(escape.defaultPrevented).toBe(true);
    });
});
