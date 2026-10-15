// Escape belongs to the newest open dialog alone: nothing behind it (the page's own Escape listeners, such as the
// mobile menu or the sleep timer, or a dialog under it) closes on the same key.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

let root: Root | null = null;
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

const press = async (key: string) =>
    act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

function Dialogs({ inner }: { inner: boolean }) {
    const [outerOpen, setOuterOpen] = useState(true);
    const [innerOpen, setInnerOpen] = useState(inner);
    return (
        <>
            <ConfirmDialog isOpen={outerOpen} onClose={() => setOuterOpen(false)} onConfirm={() => {}} title="outer" message="" />
            <ConfirmDialog isOpen={innerOpen} onClose={() => setInnerOpen(false)} onConfirm={() => {}} title="inner" message="" />
        </>
    );
}

const titles = () => Array.from(document.querySelectorAll('[role="dialog"] h3, [role="dialog"] h2')).map((h) => h.textContent);

describe("Escape and open dialogs", () => {
    it("closes the dialog, and the page's own Escape listeners never see the key", async () => {
        const behind = vi.fn();
        document.addEventListener("keydown", behind);
        root = createRoot(document.body.appendChild(document.createElement("div")));
        await act(async () => root!.render(<Dialogs inner={false} />));
        expect(titles()).toEqual(["outer"]);
        await press("Escape");
        expect(titles()).toEqual([]);
        expect(behind).not.toHaveBeenCalled();
        // With no dialog open, Escape reaches the page as usual.
        await press("Escape");
        expect(behind).toHaveBeenCalledTimes(1);
        document.removeEventListener("keydown", behind);
    });

    it("closes only the newest of two open dialogs, then the one under it", async () => {
        root = createRoot(document.body.appendChild(document.createElement("div")));
        await act(async () => root!.render(<Dialogs inner />));
        expect(titles()).toEqual(["outer", "inner"]);
        await press("Escape");
        expect(titles()).toEqual(["outer"]);
        await press("Escape");
        expect(titles()).toEqual([]);
    });
});
