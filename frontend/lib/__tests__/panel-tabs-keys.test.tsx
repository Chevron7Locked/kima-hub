/**
 * The side panel's option strip is a tablist: only the chosen tab is in the Tab order, and the arrow keys, Home and
 * End choose and focus the others.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useState } from "react";
import { PanelOptions } from "@/components/layout/panelChrome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

type Key = "up-next" | "lyrics" | "about";

function Strip({ onChange }: { onChange: (key: Key) => void }) {
    const [value, setValue] = useState<Key>("up-next");
    return (
        <PanelOptions<Key>
            label="listening"
            controls="panel-listening"
            value={value}
            onChange={(key) => {
                setValue(key);
                onChange(key);
            }}
            options={[
                { key: "up-next", label: "up next" },
                { key: "lyrics", label: "lyrics" },
                { key: "about", label: "about" },
            ]}
        />
    );
}

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const press = (key: string) =>
    act(() => {
        (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

describe("panel option strip", () => {
    it("keeps only the chosen tab in the Tab order", () => {
        act(() => root.render(<Strip onChange={vi.fn()} />));
        expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    });

    it("moves with the arrow keys, Home and End, choosing and focusing the tab", () => {
        const onChange = vi.fn<(key: Key) => void>();
        act(() => root.render(<Strip onChange={onChange} />));
        act(() => tabs()[0].focus());

        press("ArrowRight");
        expect(onChange).toHaveBeenLastCalledWith("lyrics");
        expect(document.activeElement).toBe(tabs()[1]);
        expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);

        press("End");
        expect(onChange).toHaveBeenLastCalledWith("about");
        expect(document.activeElement).toBe(tabs()[2]);

        press("ArrowRight");
        expect(onChange).toHaveBeenLastCalledWith("up-next");
        expect(document.activeElement).toBe(tabs()[0]);

        press("ArrowLeft");
        expect(onChange).toHaveBeenLastCalledWith("about");

        press("Home");
        expect(onChange).toHaveBeenLastCalledWith("up-next");
        expect(document.activeElement).toBe(tabs()[0]);
    });

    it("leaves other keys alone", () => {
        const onChange = vi.fn<(key: Key) => void>();
        act(() => root.render(<Strip onChange={onChange} />));
        act(() => tabs()[0].focus());
        press("ArrowDown");
        press("a");
        expect(onChange).not.toHaveBeenCalled();
    });
});
