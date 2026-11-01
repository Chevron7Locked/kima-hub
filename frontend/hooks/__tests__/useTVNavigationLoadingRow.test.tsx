/**
 * A row still loading on a TV (placeholder cards, nothing to focus) does not stop the remote: down and up step over
 * it to the next row that has cards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";

vi.mock("@/lib/tv-utils", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/tv-utils")>()),
    useIsTV: () => true,
}));

import { useTVNavigation } from "@/hooks/useTVNavigation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const probe = {} as { key: (key: string) => void };
const onBack = vi.fn();
const layout = { rows: [] as Array<[string, boolean]> };

function Row({ name, loading }: { name: string; loading?: boolean }) {
    return (
        <section data-tv-section={name}>
            {[0, 1, 2].map((i) =>
                loading ? (
                    <div key={i} data-placeholder-card="" />
                ) : (
                    <a key={i} href={`#${name}-${i}`} data-tv-card="true" id={`${name}-${i}`}>
                        {name} {i}
                    </a>
                ),
            )}
        </section>
    );
}

function Page() {
    const { containerRef, handleKeyDown } = useTVNavigation({ onBack });
    useEffect(() => {
        probe.key = (key) => handleKeyDown(new KeyboardEvent("keydown", { key, cancelable: true }));
    });
    return (
        <main ref={containerRef as React.RefObject<HTMLElement>}>
            {layout.rows.map(([name, loading]) => (
                <Row key={name} name={name} loading={loading} />
            ))}
        </main>
    );
}

let root: Root;
let host: HTMLDivElement;
const focused = () => (document.activeElement as HTMLElement | null)?.id;
const press = async (key: string) => act(async () => probe.key(key));

async function show(rows: Array<[string, boolean]>) {
    layout.rows = rows;
    await act(async () => root.render(<Page />));
}

beforeEach(() => {
    onBack.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("rows still loading", () => {
    it("are stepped over going down and up", async () => {
        await show([["a", false], ["b", true], ["c", true], ["d", false]]);
        await act(async () => document.getElementById("a-1")!.focus());
        await press("ArrowDown");
        expect(focused()).toBe("d-1");
        await press("ArrowUp");
        expect(focused()).toBe("a-1");
    });

    it("leave down where it is when only loading rows are below", async () => {
        await show([["a", false], ["b", true]]);
        await act(async () => document.getElementById("a-2")!.focus());
        await press("ArrowDown");
        expect(focused()).toBe("a-2");
    });

    it("send up to the menu when only loading rows are above", async () => {
        await show([["a", true], ["b", false]]);
        await act(async () => document.getElementById("b-0")!.focus());
        await press("ArrowUp");
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});
