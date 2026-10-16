/**
 * Back (Escape on a remote) returns to the TV tab row from anywhere in the content, including a page built without
 * TV sections and with nothing focused, which is where opening a card with Enter lands (an artist or album page).
 * An Escape that something on the page already used (and marked handled, as the app's Escape handlers do) is not Back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect, useLayoutEffect } from "react";

vi.mock("@/lib/tv-utils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/tv-utils")>()),
    useIsTV: () => true,
}));

import { useTVNavigation } from "@/hooks/useTVNavigation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const onBack = vi.fn();
const probe = {} as { handleKeyDown: (e: KeyboardEvent) => void };

function Page() {
    const { containerRef, handleKeyDown } = useTVNavigation({ onBack });
    useEffect(() => {
        probe.handleKeyDown = handleKeyDown;
    });
    // A page with no [data-tv-section]: just a card, as an artist page's discography renders.
    return (
        <main ref={containerRef as React.RefObject<HTMLElement>}>
            <a href="#album" data-tv-card="true">
                album
            </a>
        </main>
    );
}

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
    onBack.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Page />));
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const escape = () => new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

describe("Back on a TV page without sections", () => {
    it("returns to the tab row even when nothing on the page has the focus", async () => {
        // Content was focused (a card), then the page changed and the focus fell to the body.
        await act(async () => host.querySelector<HTMLAnchorElement>("[data-tv-card]")!.focus());
        await act(async () => (document.activeElement as HTMLElement).blur());
        expect(document.activeElement).toBe(document.body);

        await act(async () => probe.handleKeyDown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("leaves an Escape alone that something on the page already used (a rename, a popover, a menu)", async () => {
        const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
        handled.preventDefault();

        await act(async () => probe.handleKeyDown(handled));
        await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

        expect(onBack).not.toHaveBeenCalled();
    });
});

/** Runs the waiting Back in the same commit as the page's change, after the page's layout effects. */
function RunPendingTimers({ run }: { run: boolean }) {
    useLayoutEffect(() => {
        if (run) vi.runOnlyPendingTimers();
    });
    return null;
}

function Content({ enabled, back }: { enabled: boolean; back: () => void }) {
    const { containerRef, handleKeyDown } = useTVNavigation({ onBack: back, enabled });
    useEffect(() => {
        probe.handleKeyDown = handleKeyDown;
    });
    return <main ref={containerRef as React.RefObject<HTMLElement>} />;
}

function Screen({ show = true, enabled = true, back, run = false }: { show?: boolean; enabled?: boolean; back: () => void; run?: boolean }) {
    return (
        <>
            {show && <Content enabled={enabled} back={back} />}
            <RunPendingTimers run={run} />
        </>
    );
}

describe("a Back still waiting when the page changes", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("calls the page's latest Back", async () => {
        const first = vi.fn();
        const latest = vi.fn();
        await act(async () => root.render(<Screen back={first} />));
        await act(async () => probe.handleKeyDown(escape()));
        await act(async () => root.render(<Screen back={latest} run />));

        expect(first).not.toHaveBeenCalled();
        expect(latest).toHaveBeenCalledTimes(1);
    });

    it("does nothing once TV navigation is switched off", async () => {
        const back = vi.fn();
        await act(async () => root.render(<Screen back={back} />));
        await act(async () => probe.handleKeyDown(escape()));
        await act(async () => root.render(<Screen back={back} enabled={false} run />));

        expect(back).not.toHaveBeenCalled();
    });

    it("does nothing once the page is gone", async () => {
        const back = vi.fn();
        await act(async () => root.render(<Screen back={back} />));
        await act(async () => probe.handleKeyDown(escape()));
        await act(async () => root.render(<Screen back={back} show={false} run />));

        expect(back).not.toHaveBeenCalled();
    });
});
