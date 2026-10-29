/**
 * The switch that runs audio analysis and sound vectors side by side: turning it on asks first and saves only on
 * yes; "keep one at a time" leaves it off and saves nothing; turning it off saves at once, no question.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const getTogether = vi.fn();
const setTogether = vi.fn();

vi.mock("@/lib/api", () => ({
    api: {
        getAnalysisTogether: (...a: unknown[]) => getTogether(...a),
        setAnalysisTogether: (...a: unknown[]) => setTogether(...a),
    },
}));

import { BothAtOnceSwitch } from "@/components/enrichment/BothAtOnceSwitch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const box = () => container.querySelector("#t") as HTMLInputElement;
const button = (text: string) =>
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().toLowerCase() === text) as HTMLButtonElement | undefined;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** Renders the switch over a stored setting, or over a read that fails. */
async function render(stored: boolean | Error) {
    if (stored instanceof Error) getTogether.mockRejectedValueOnce(stored);
    else getTogether.mockResolvedValue({ together: stored });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(<QueryClientProvider client={client}><BothAtOnceSwitch id="t" /></QueryClientProvider>);
    });
    await settle();
}

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setTogether.mockImplementation(async (together: boolean) => ({ together }));
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
});

describe("BothAtOnceSwitch", () => {
    it("asks before turning on, and saves only on yes", async () => {
        await render(false);
        expect(box().checked).toBe(false);
        await act(async () => box().click());
        expect(setTogether).not.toHaveBeenCalled();
        expect(document.body.textContent?.toLowerCase()).toContain("run both at the same time?");

        await act(async () => button("run both at once")!.click());
        await settle();
        expect(setTogether).toHaveBeenCalledWith(true);
        expect(box().checked).toBe(true);
    });

    it("stays off and saves nothing when the warning is declined", async () => {
        await render(false);
        await act(async () => box().click());
        await act(async () => button("keep one at a time")!.click());
        await settle();
        expect(setTogether).not.toHaveBeenCalled();
        expect(box().checked).toBe(false);
    });

    it("turns off at once, without asking", async () => {
        await render(true);
        expect(box().checked).toBe(true);
        await act(async () => box().click());
        await settle();
        expect(button("run both at once")).toBeUndefined();
        expect(setTogether).toHaveBeenCalledWith(false);
        expect(box().checked).toBe(false);
    });

    it("says when the setting couldn't be read, and reads it again on request", async () => {
        await render(new Error("down"));
        expect(box().disabled).toBe(true);
        expect(container.textContent?.toLowerCase()).toContain("couldn't read this setting");
        getTogether.mockResolvedValueOnce({ together: false });
        await act(async () => button("try again")!.click());
        await settle();
        expect(box().disabled).toBe(false);
        expect(container.textContent?.toLowerCase()).not.toContain("couldn't read this setting");
    });
});
