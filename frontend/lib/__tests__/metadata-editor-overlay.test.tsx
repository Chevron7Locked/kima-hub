/**
 * The metadata editor's window is drawn at the page's top level. Opened from inside an animated header (a transform
 * makes that header the box `position: fixed` is measured against), an overlay left in place is clipped to the header
 * and painted under the content after it, so its buttons cannot be pressed.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { MetadataEditor } from "@/components/MetadataEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let header: HTMLDivElement;

beforeEach(() => {
    header = document.createElement("div");
    header.style.transform = "translateY(0)";
    document.body.appendChild(header);
    root = createRoot(header);
});
afterEach(() => {
    act(() => root.unmount());
    header.remove();
});

it("opens its window outside the element that holds its button", async () => {
    await act(async () => root.render(<MetadataEditor type="artist" id="a1" currentData={{ name: "n" }} />));
    await act(async () => (header.querySelector("button") as HTMLButtonElement).click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(header.contains(dialog)).toBe(false);
});
