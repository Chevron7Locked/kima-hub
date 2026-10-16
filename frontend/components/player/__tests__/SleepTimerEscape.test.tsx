/**
 * Escape closes the open sleep timer and marks the key as used, so page-wide Escape handlers (TV Back, the vibe
 * page's undo) leave it alone, as the app's Escape handlers agree to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/hooks/useSleepTimer", () => ({
    useSleepTimer: () => ({ isActive: false, remainingSeconds: 0, displayRemaining: "", setTimer: vi.fn(), clearTimer: vi.fn() }),
}));

import { SleepTimer } from "@/components/player/SleepTimer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<SleepTimer />));
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("the sleep timer and Escape", () => {
    it("closes on Escape and marks the key as used", async () => {
        const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
        await act(async () => trigger.click());
        expect(trigger.getAttribute("aria-expanded")).toBe("true");

        const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        await act(async () => document.body.dispatchEvent(escape));

        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(escape.defaultPrevented, "the Escape that closed it is not marked as used").toBe(true);
    });

    it("leaves Escape unmarked while closed", async () => {
        const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        await act(async () => document.body.dispatchEvent(escape));

        expect(escape.defaultPrevented).toBe(false);
    });
});
