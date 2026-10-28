/**
 * The edit button beside an album or artist title shows only to admins: the server refuses a member's
 * edit and reset (requireAdmin on /enrichment/.../metadata and /reset).
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

let role: string | null = "user";
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: role === null ? null : { id: "u1", role } }) }));
vi.mock("@/components/MetadataEditor", () => ({ MetadataEditor: () => <button>edit</button> }));

import { MetadataEditControls } from "@/components/MetadataEditControls";

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

const show = async () => {
    await act(async () => root.render(
        <MetadataEditControls edited editable type="album" id="a1" currentData={{ title: "t" }} onSave={() => {}} />,
    ));
    // The editor is loaded lazily: wait until that import has settled, so a missing button means it was not shown.
    await act(async () => { await vi.dynamicImportSettled(); await new Promise((r) => setTimeout(r, 0)); });
};

it("a member sees the edited mark but no edit button", async () => {
    role = "user";
    await show();
    expect(container.textContent).toContain("Edited");
    expect(container.querySelector("button")).toBeNull();
});

it("an admin sees the edit button", async () => {
    role = "admin";
    await show();
    expect(container.querySelector("button")?.textContent).toBe("edit");
});

it("a user with any other role sees no edit button", async () => {
    for (const other of ["", "moderator"]) {
        role = other;
        await show();
        expect([other, container.querySelector("button")]).toEqual([other, null]);
    }
});

it("nobody signed in yet (auth still loading) sees no edit button", async () => {
    role = null;
    await show();
    expect(container.querySelector("button")).toBeNull();
});
