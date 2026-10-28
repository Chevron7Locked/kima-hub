/**
 * The metadata editor compares the edited genres with the original ones without reordering either: it sorts copies,
 * never the props or the form state it renders from.
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

import { MetadataEditor } from "@/components/MetadataEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

it("opening the editor leaves the original and current genre lists in their order", async () => {
    const original = ["rock", "ambient"];
    const genres = ["shoegaze", "dream pop"];
    await act(async () => root.render(
        <MetadataEditor type="album" id="a1" currentData={{ title: "t", genres, _originalGenres: original }} />,
    ));
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());

    expect(document.body.textContent).toContain("Original: rock, ambient");
    expect(original).toEqual(["rock", "ambient"]);
    expect(genres).toEqual(["shoegaze", "dream pop"]);
});
