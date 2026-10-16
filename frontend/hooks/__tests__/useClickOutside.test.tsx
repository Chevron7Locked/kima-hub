/** A press outside every given element calls back, a press inside any of them does not; off while not enabled. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act, useRef } from "react";
import { useClickOutside } from "@/hooks/useClickOutside";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Popover({ onOutside, enabled = true, withButton = false }: { onOutside: () => void; enabled?: boolean; withButton?: boolean }) {
    const panel = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    useClickOutside(withButton ? [panel, button] : [panel], onOutside, enabled);
    return (
        <div>
            <button ref={button} id="button">open</button>
            <div ref={panel} id="panel"><span id="inside">inside</span></div>
            <p id="outside">elsewhere</p>
        </div>
    );
}

let root: Root;
let host: HTMLDivElement;
const press = (id: string) =>
    act(() => {
        document.getElementById(id)!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
const show = (ui: React.ReactElement) => act(() => root.render(ui));

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("useClickOutside", () => {
    it("calls back on a press outside, not on one inside", () => {
        const onOutside = vi.fn();
        show(<Popover onOutside={onOutside} />);
        press("inside");
        expect(onOutside).not.toHaveBeenCalled();
        press("outside");
        expect(onOutside).toHaveBeenCalledTimes(1);
    });

    it("treats a press on any of the elements as inside", () => {
        const onOutside = vi.fn();
        show(<Popover onOutside={onOutside} withButton />);
        press("button");
        expect(onOutside).not.toHaveBeenCalled();
        press("outside");
        expect(onOutside).toHaveBeenCalledTimes(1);
    });

    it("does nothing while not enabled, and uses the newest callback", () => {
        const first = vi.fn();
        const second = vi.fn();
        show(<Popover onOutside={first} enabled={false} />);
        press("outside");
        expect(first).not.toHaveBeenCalled();
        show(<Popover onOutside={second} enabled />);
        press("outside");
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});
