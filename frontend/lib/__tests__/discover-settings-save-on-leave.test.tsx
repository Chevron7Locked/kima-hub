/**
 * A Discover setting is saved half a second after the slider stops. Leaving the settings before then (back to
 * activity, or another page) saves it on the way out, and a second slider moved inside that half second does not
 * drop the first one's change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const updateDiscoverConfig = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/api")>()),
    api: { clearDiscoverPlaylist: vi.fn(), updateDiscoverConfig: (c: unknown) => updateDiscoverConfig(c) },
}));
vi.mock("@/lib/notify", () => ({ notify: { info: vi.fn(), error: vi.fn() } }));

import { DiscoverSettingsTab } from "@/components/activity/DiscoverSettingsTab";
import type { DiscoverConfig } from "@/features/discover/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const config = { playlistSize: 10, downloadRatio: 1.3, exclusionMonths: 6 } as DiscoverConfig;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    vi.useFakeTimers();
    updateDiscoverConfig.mockResolvedValue(config);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<DiscoverSettingsTab config={config} onUpdateConfig={() => {}} onBack={() => {}} />));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
});

/** Moves a range input the way a browser does, so React's onChange fires. */
function slide(index: number, value: number) {
    const input = host.querySelectorAll<HTMLInputElement>('input[type="range"]')[index];
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
        setValue.call(input, String(value));
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

describe("saving Discover settings", () => {
    it("saves once, half a second after the slider stops", () => {
        slide(0, 20);
        slide(0, 25);
        expect(updateDiscoverConfig).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(500));
        expect(updateDiscoverConfig).toHaveBeenCalledTimes(1);
        expect(updateDiscoverConfig).toHaveBeenCalledWith({ playlistSize: 25 });
    });

    it("saves a change made just before leaving the settings", () => {
        slide(0, 25);
        act(() => root.unmount());
        expect(updateDiscoverConfig).toHaveBeenCalledTimes(1);
        expect(updateDiscoverConfig).toHaveBeenCalledWith({ playlistSize: 25 });
        act(() => vi.advanceTimersByTime(1000));
        expect(updateDiscoverConfig).toHaveBeenCalledTimes(1);
        // afterEach unmounts again; give it a fresh root so that is harmless.
        root = createRoot(host);
    });

    it("keeps the first slider's change when a second slider moves within half a second", () => {
        slide(0, 25);
        slide(2, 3);
        act(() => vi.advanceTimersByTime(500));
        expect(updateDiscoverConfig).toHaveBeenCalledTimes(1);
        expect(updateDiscoverConfig).toHaveBeenCalledWith({ playlistSize: 25, exclusionMonths: 3 });
    });

    it("sends nothing on leaving when every change is already saved", () => {
        slide(0, 25);
        act(() => vi.advanceTimersByTime(500));
        act(() => root.unmount());
        expect(updateDiscoverConfig).toHaveBeenCalledTimes(1);
        root = createRoot(host);
    });
});
