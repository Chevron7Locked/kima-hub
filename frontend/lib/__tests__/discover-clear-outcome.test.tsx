/**
 * The clear reports what the server said. Kima's own error answer is a failure; no answer at all (the connection
 * dropped, or a proxy in front of Kima gave up and answered for it) is not, because the clear may still be running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const clearDiscoverPlaylist = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/api")>()),
    api: { clearDiscoverPlaylist: () => clearDiscoverPlaylist(), updateDiscoverConfig: vi.fn() },
}));
const info = vi.fn();
const error = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: { info: (...a: unknown[]) => info(...a), error: (...a: unknown[]) => error(...a) } }));

import { DiscoverSettingsTab } from "@/components/activity/DiscoverSettingsTab";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const cleared = vi.fn();

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<DiscoverSettingsTab config={null} onUpdateConfig={() => {}} onPlaylistCleared={cleared} onBack={() => {}} />));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
});

function button(text: string) {
    const found = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim().toLowerCase() === text);
    if (!found) throw new Error(`no "${text}" button`);
    return found;
}

async function clear() {
    act(() => button("clear playlist").click());
    await act(async () => button("clear").click());
}

/** The error lib/api.ts throws for a reply that is not ok, built from the reply's body the way it builds it. */
const failed = (status: number, data: Record<string, unknown>) => Object.assign(new Error(String(data.error)), { status, data });
const gaveUp = (status: number, statusText: string) =>
    failed(status, { error: statusText, status, parseError: "Failed to parse error response" });

describe("clearing Discover", () => {
    it("reports what a finished clear did", async () => {
        clearDiscoverPlaylist.mockResolvedValue({ success: true, likedMoved: 1, activeDeleted: 3, lidarrFailed: [] });
        await clear();
        expect(info).toHaveBeenCalledWith("discover playlist cleared", expect.objectContaining({ groupKey: "discover-clear" }));
        expect(error).not.toHaveBeenCalled();
        expect(cleared).toHaveBeenCalled();
    });

    it("reports Kima's own error answer as a failure, with its reason", async () => {
        clearDiscoverPlaylist.mockRejectedValue(failed(500, { error: "Lidarr is not answering" }));
        await clear();
        expect(error).toHaveBeenCalledWith(
            "failed to clear playlist",
            expect.objectContaining({ message: "Lidarr is not answering", groupKey: "discover-clear" }),
        );
        expect(info).not.toHaveBeenCalled();
    });

    it.each([
        ["the connection dropped", new TypeError("Failed to fetch")],
        ["Next's proxy gave up and answered in plain text", gaveUp(500, "Internal Server Error")],
        ["a reverse proxy gave up and answered in HTML", gaveUp(504, "Gateway Timeout")],
        ["a proxy answered JSON that is not Kima's", failed(502, { message: "Bad Gateway" })],
    ])("does not call it a failure when %s", async (_case, err) => {
        clearDiscoverPlaylist.mockRejectedValue(err);
        await clear();
        expect(error).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledWith(
            "no answer from the discover clear yet",
            expect.objectContaining({ groupKey: "discover-clear", message: expect.stringContaining("refresh") }),
        );
        // The clear may still be running, so the page is not reloaded as if it had finished.
        expect(cleared).not.toHaveBeenCalled();
    });
});
