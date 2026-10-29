// Escape in the playlist page's rename field cancels the rename and marks the key as used, so page-wide Escape
// handlers (TV Back) leave it alone. The real page; the server, the player and the router are stand-ins.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
    useParams: () => ({ id: "p-1" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
    usePathname: () => "/playlist/p-1",
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: "u-1" } }) }));
vi.mock("@/lib/audio-context", () => ({
    useAudioState: () => ({ currentTrack: null }),
    useAudioPlayback: () => ({ isPlaying: false }),
    useAudioControls: () => ({ playTracks: vi.fn(), addToQueue: vi.fn(), pause: vi.fn(), resumeWithGesture: vi.fn() }),
}));
vi.mock("@/hooks/usePreview", () => ({ usePreview: () => ({ toggle: vi.fn(), previewId: null }) }));
const updatePlaylist = vi.fn(async () => ({}));
vi.mock("@/lib/api", () => ({
    api: {
        getPlaylist: async () => ({ id: "p-1", name: "Mine", isOwner: true, isPublic: false, isHidden: false, items: [], pendingTracks: [] }),
        getPublicConfig: async () => ({ publicUrl: "", canAcquire: false }),
        updatePlaylist: (...args: unknown[]) => updatePlaylist(...(args as [])),
    },
    getApiBaseUrl: () => "",
}));

import PlaylistPage from "@/app/playlist/[id]/page";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

describe("the playlist page's rename field and Escape", () => {
    it("cancels the rename, saves nothing, and marks the key as used", async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        container = document.body.appendChild(document.createElement("div"));
        root = createRoot(container);
        await act(async () => root.render(<QueryClientProvider client={client}><PlaylistPage /></QueryClientProvider>));
        await act(async () => new Promise((r) => setTimeout(r, 0)));

        await act(async () => container.querySelector<HTMLElement>("h1")!.click());
        const field = container.querySelector<HTMLInputElement>('input[type="text"]')!;
        expect(field.value).toBe("Mine");

        const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        await act(async () => field.dispatchEvent(escape));

        expect(container.querySelector('input[type="text"]'), "the rename field is still open").toBeNull();
        expect(updatePlaylist).not.toHaveBeenCalled();
        expect(escape.defaultPrevented).toBe(true);
    });
});
