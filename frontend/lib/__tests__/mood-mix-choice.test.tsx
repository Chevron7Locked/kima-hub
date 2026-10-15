/**
 * The release window's mood-mix question (save as playlist, rebuild, keep):
 * what the user sees after each answer, including save-then-rebuild and that
 * a failed call never looks like it worked.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const getState = vi.fn();
const decide = vi.fn();
const save = vi.fn();

vi.mock("@/lib/api", () => ({
    api: {
        getMoodMixReleaseState: (...a: unknown[]) => getState(...a),
        decideMoodMixes: (...a: unknown[]) => decide(...a),
        saveMoodMixAsPlaylist: (...a: unknown[]) => save(...a),
    },
}));

import { MoodMixChoice } from "@/components/whats-new/MoodMixChoice";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MIX = { id: "your-mood-mix-1", name: "Your Upbeat Mix", mood: "happy", trackCount: 15, retired: false };
const RETIRED = { id: "your-mood-mix-2", name: "Your Focus Mode Mix", mood: "focus", trackCount: 12, retired: true };

let container: HTMLDivElement;
let root: Root;

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function render() {
    await act(async () => {
        root.render(<QueryClientProvider client={new QueryClient()}><MoodMixChoice /></QueryClientProvider>);
    });
}

async function click(id: string) {
    await act(async () => {
        q(id)!.click();
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe("MoodMixChoice", () => {
    it("shows the mix and all three answers before anything is decided", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: null, playlist: null });
        await render();
        expect(q("moodmix-name")!.textContent).toContain("Your Upbeat Mix");
        expect(q("moodmix-name")!.textContent).toContain("15 tracks");
        expect(q("moodmix-save")).not.toBeNull();
        expect(q("moodmix-rebuild")!.getAttribute("aria-pressed")).toBe("false");
        expect(q("moodmix-keep")!.getAttribute("aria-pressed")).toBe("false");
    });

    it("keep marks Keep as chosen and leaves the mix and the other answers on screen", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: null, playlist: null });
        decide.mockResolvedValue({ decision: "keep", removed: 0 });
        await render();
        await click("moodmix-keep");
        expect(decide).toHaveBeenCalledWith("keep");
        expect(q("moodmix-keep")!.getAttribute("aria-pressed")).toBe("true");
        expect(q("moodmix-name")).not.toBeNull();
        expect(q("moodmix-rebuild")).not.toBeNull();
    });

    it("rebuild clears the mix from the item", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: null, playlist: null });
        decide.mockResolvedValue({ decision: "rebuild", removed: 1 });
        await render();
        await click("moodmix-rebuild");
        expect(decide).toHaveBeenCalledWith("rebuild");
        expect(q("moodmix-name")).toBeNull();
        expect(q("moodmix-save")).toBeNull();
        expect(q("moodmix-rebuilt")!.textContent).toBe("Cleared");
    });

    it("save then rebuild: the saved playlist is still named after the mix is cleared", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: null, playlist: null });
        save.mockResolvedValue({ id: "pl1", name: "Your Upbeat Mix", trackCount: 15, created: true });
        decide.mockResolvedValue({ decision: "rebuild", removed: 1 });
        await render();

        await click("moodmix-save");
        expect(save).toHaveBeenCalledWith("your-mood-mix-1");
        expect(q("moodmix-save")).toBeNull();
        expect(q("moodmix-saved")!.querySelector("a")!.getAttribute("href")).toBe("/playlist/pl1");

        await click("moodmix-rebuild");
        expect(q("moodmix-saved")).not.toBeNull();
        expect(q("moodmix-rebuilt")).not.toBeNull();
    });

    it("a failed save says so and offers the button again", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: null, playlist: null });
        save.mockRejectedValue(new Error("404"));
        await render();
        await click("moodmix-save");
        expect(q("moodmix-error")!.textContent).toContain("Couldn't save");
        expect(q("moodmix-saved")).toBeNull();
        expect((q("moodmix-save") as HTMLButtonElement).disabled).toBe(false);
    });

    it("a failed rebuild keeps the mix on screen", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: null, playlist: null });
        decide.mockRejectedValue(new Error("500"));
        await render();
        await click("moodmix-rebuild");
        expect(q("moodmix-name")).not.toBeNull();
        expect(q("moodmix-rebuilt")).toBeNull();
        expect(q("moodmix-error")!.textContent).toBe("Couldn't clear the mix");
    });

    it("starts from what the server already recorded (answered on another device)", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: "keep", playlist: { id: "pl9", name: "Your Upbeat Mix" } });
        await render();
        expect(q("moodmix-keep")!.getAttribute("aria-pressed")).toBe("true");
        expect(q("moodmix-save")).toBeNull();
        expect(q("moodmix-saved")).not.toBeNull();
    });

    it("a current mix offers no Remove", async () => {
        getState.mockResolvedValue({ mix: MIX, decision: null, playlist: null });
        await render();
        expect(q("moodmix-remove")).toBeNull();
    });

    describe("a mix under a removed mood", () => {
        it("offers Save as playlist and Remove, and no Rebuild or Keep", async () => {
            getState.mockResolvedValue({ mix: RETIRED, decision: null, playlist: null });
            await render();
            expect(q("moodmix-name")!.textContent).toContain("Your Focus Mode Mix");
            expect(q("moodmix-save")).not.toBeNull();
            expect(q("moodmix-remove")).not.toBeNull();
            expect(q("moodmix-keep")).toBeNull();
            expect(q("moodmix-rebuild")).toBeNull();
        });

        it("save then remove: the playlist is still named, and the item says Removed", async () => {
            getState.mockResolvedValue({ mix: RETIRED, decision: null, playlist: null });
            save.mockResolvedValue({ id: "pl2", name: "Your Focus Mode Mix", trackCount: 12, created: true });
            decide.mockResolvedValue({ decision: "remove", removed: 1 });
            await render();
            await click("moodmix-save");
            expect(save).toHaveBeenCalledWith("your-mood-mix-2");
            expect(q("moodmix-remove")).not.toBeNull();
            await click("moodmix-remove");
            expect(decide).toHaveBeenCalledWith("remove");
            expect(q("moodmix-saved")).not.toBeNull();
            expect(q("moodmix-rebuilt")!.textContent).toBe("Removed.");
        });

        it("a failed remove keeps the mix on screen", async () => {
            getState.mockResolvedValue({ mix: RETIRED, decision: null, playlist: null });
            decide.mockRejectedValue(new Error("500"));
            await render();
            await click("moodmix-remove");
            expect(q("moodmix-name")).not.toBeNull();
            expect(q("moodmix-error")!.textContent).toBe("Couldn't clear the mix");
        });
    });

    it("says so when the state cannot be loaded", async () => {
        getState.mockRejectedValue(new Error("network"));
        await render();
        expect(container.textContent).toContain("Couldn’t load your mood mix");
        expect(q("moodmix-rebuild")).toBeNull();
    });
});
