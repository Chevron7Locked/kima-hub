/**
 * A TV remote moves between rows of cards. Rows can appear while the page is open (a category row whose shows
 * arrive later), so the remote reads where the focus is from the page, and a row added above the focused one does
 * not move it onto another row or restore another row's column.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect, useState } from "react";

vi.mock("@/lib/tv-utils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/tv-utils")>()),
    useIsTV: () => true,
}));

import { useTVNavigation } from "@/hooks/useTVNavigation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const probe = {} as { key: (key: string) => void; showB: () => void };

function Row({ name }: { name: string }) {
    return (
        <section data-tv-section={name}>
            <a href={`#${name}-all`} id={`${name}-all`}>
                show all
            </a>
            {[0, 1, 2].map((i) => (
                <a key={i} href={`#${name}-${i}`} data-tv-card="true" id={`${name}-${i}`}>
                    {name} {i}
                </a>
            ))}
        </section>
    );
}

function Page() {
    const { containerRef, handleKeyDown } = useTVNavigation();
    const [showB, setShowB] = useState(false);
    useEffect(() => {
        probe.key = (key) => handleKeyDown(new KeyboardEvent("keydown", { key, cancelable: true }));
        probe.showB = () => setShowB(true);
    });
    return (
        <main ref={containerRef as React.RefObject<HTMLElement>}>
            <Row name="a" />
            {showB && <Row name="b" />}
            <Row name="c" />
            <Row name="d" />
        </main>
    );
}

let root: Root;
let host: HTMLDivElement;
const focused = () => (document.activeElement as HTMLElement | null)?.id;
const press = async (key: string) => act(async () => probe.key(key));

beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Page />));
    Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("a row that appears above the focused one", () => {
    it("leaves left, right, up and down acting on the row the focus is really in", async () => {
        await act(async () => document.getElementById("a-0")!.focus());
        await press("ArrowDown"); // c
        await press("ArrowDown"); // d
        await press("ArrowRight");
        expect(focused()).toBe("d-1");
        await act(async () => probe.showB()); // b arrives above: a, b, c, d
        await press("ArrowRight");
        expect(focused()).toBe("d-2");
        await press("ArrowUp"); // c, at the column it was left on
        expect(focused()).toBe("c-0");
        await press("ArrowUp"); // b, never visited: the same column
        expect(focused()).toBe("b-0");
        await press("ArrowDown");
        expect(focused()).toBe("c-0");
    });

    it("brings back each row's own column, not the column of the row that used to sit at its place", async () => {
        await act(async () => document.getElementById("a-0")!.focus());
        await press("ArrowDown"); // c-0
        await press("ArrowRight"); // c-1
        await press("ArrowDown"); // d-1
        await press("ArrowRight"); // d-2
        await act(async () => probe.showB()); // a, b, c, d
        await press("ArrowUp"); // back to c: its own column, 1
        expect(focused()).toBe("c-1");
    });

    it("starts a row at its first card from the row's own \"show all\" link, whatever column was used before", async () => {
        await act(async () => document.getElementById("a-0")!.focus());
        await press("ArrowRight");
        await press("ArrowRight"); // a-2
        await act(async () => document.getElementById("c-all")!.focus());
        await press("ArrowRight");
        expect(focused()).toBe("c-0");
        await act(async () => document.getElementById("c-all")!.focus());
        await press("ArrowDown");
        expect(focused()).toBe("d-0");
    });
});
