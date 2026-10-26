/**
 * The collection's Refine panel: its choices are radio groups, it says what is changed, resets in one step, and closes
 * when focus leaves it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { RefinePanel } from "@/features/library/components/RefinePanel";
import type { LibraryFilter, SortOption } from "@/hooks/useQueries";

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

function show(props: Partial<React.ComponentProps<typeof RefinePanel>> = {}) {
    const handlers = {
        onFilterChange: vi.fn<(f: LibraryFilter) => void>(),
        onSortChange: vi.fn<(s: SortOption) => void>(),
        onItemsPerPageChange: vi.fn<(n: number) => void>(),
        onReset: vi.fn<() => void>(),
    };
    act(() =>
        root.render(
            <RefinePanel activeTab="albums" filter="owned" sortBy="name" itemsPerPage={40} {...handlers} {...props} />,
        ),
    );
    return handlers;
}

const trigger = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const panel = () => document.getElementById("refine-panel");
const open = () => act(() => trigger().click());
const group = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find(
        (g) => document.getElementById(g.getAttribute("aria-labelledby")!)?.textContent === name,
    )!;
const radios = (g: HTMLElement) => [...g.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

describe("RefinePanel", () => {
    it("offers each setting as a radio group with one checked choice, the only one Tab reaches", () => {
        show({ sortBy: "name-desc" });
        open();
        for (const name of ["Sort by", "Show", "Per page"]) {
            const choices = radios(group(name));
            expect(choices.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
            expect(choices.filter((r) => r.tabIndex === 0)).toHaveLength(1);
        }
        const checked = radios(group("Sort by")).find((r) => r.getAttribute("aria-checked") === "true")!;
        expect(checked.textContent).toBe("Name (Z–A)");
    });

    it("moves and chooses with the arrow keys, wrapping at the ends", () => {
        const { onSortChange, onItemsPerPageChange } = show();
        open();
        act(() => {
            group("Sort by").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        });
        expect(onSortChange).toHaveBeenLastCalledWith("name-desc");
        act(() => {
            group("Per page").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        });
        expect(onItemsPerPageChange).toHaveBeenLastCalledWith(24);
        act(() => {
            group("Sort by").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        });
        expect(onSortChange).toHaveBeenLastCalledWith("recent");
    });

    it("names what is changed on the trigger and offers reset only then", () => {
        show();
        expect(trigger().getAttribute("aria-label")).not.toMatch(/changed/);
        open();
        expect([...panel()!.querySelectorAll("button")].some((b) => b.textContent === "Reset")).toBe(false);

        const { onReset } = show({ filter: "all", itemsPerPage: 80 });
        expect(trigger().getAttribute("aria-label")).toBe("Refine, changed: All, 80 per page");
        const reset = [...panel()!.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
        act(() => reset.click());
        expect(onReset).toHaveBeenCalledTimes(1);
    });

    it("describes the chosen filter in the tab's own words", () => {
        show({ activeTab: "albums", filter: "discovery" });
        open();
        expect(panel()!.textContent).toContain("Albums suggested by your listening history");
        show({ activeTab: "artists", filter: "discovery" });
        expect(panel()!.textContent).toContain("Artists suggested by your listening history");
    });

    it("has no filter on the tracks tab, and a filter left in the address does not count as changed there", () => {
        show({ activeTab: "tracks", filter: "all" });
        open();
        expect(group("Show")).toBeUndefined();
        expect(trigger().getAttribute("aria-label")).not.toMatch(/changed/);
    });

    it("closes when focus moves out of it, and stays open while focus moves inside", () => {
        show();
        open();
        const [first, second] = radios(group("Sort by"));
        act(() => {
            first.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: second }));
        });
        expect(panel()).not.toBeNull();
        const outside = document.createElement("button");
        document.body.appendChild(outside);
        act(() => {
            first.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
        });
        expect(panel()).toBeNull();
        expect(trigger().getAttribute("aria-expanded")).toBe("false");
        outside.remove();
    });

    it("takes focus to the chosen sort on open, and gives it back to the button when Tab leaves either end", () => {
        show({ sortBy: "name-desc" });
        open();
        expect(document.activeElement?.textContent).toBe("Name (Z–A)");
        const tab = (shiftKey: boolean) =>
            act(() => {
                document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true }));
            });
        // Shift+Tab from the chosen sort stays inside: reset and close come before it. From reset, the first stop, it leaves.
        tab(true);
        expect(panel()).not.toBeNull();
        [...panel()!.querySelectorAll("button")].find((b) => b.textContent === "Reset")!.focus();
        tab(true);
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(trigger());

        open();
        radios(group("Per page")).find((r) => r.tabIndex === 0)!.focus();
        tab(false);
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(trigger());
    });

    it("builds each arrow press on the focused choice, when the address has not caught up with the last one", () => {
        const { onSortChange } = show();
        open();
        const press = (key: string) =>
            act(() => {
                document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
            });
        expect(document.activeElement?.textContent).toBe("Name (A–Z)");
        press("ArrowRight");
        press("ArrowRight");
        expect(onSortChange.mock.calls.map(([v]) => v)).toEqual(["name-desc", "recent"]);
        press("Home");
        press("End");
        expect(onSortChange.mock.calls.slice(2).map(([v]) => v)).toEqual(["name", "recent"]);
    });

    it("keeps focus in the panel when reset removes its own button", () => {
        const { onReset } = show({ sortBy: "recent", itemsPerPage: 80 });
        open();
        const reset = [...panel()!.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
        reset.focus();
        act(() => reset.click());
        expect(onReset).toHaveBeenCalledTimes(1);
        show({ sortBy: "name", itemsPerPage: 40, onReset });
        expect(panel()).not.toBeNull();
        expect(panel()!.contains(document.activeElement)).toBe(true);
        expect(document.activeElement?.textContent).toBe("Name (A–Z)");
    });

    it("names the panel it controls only while it is open", () => {
        show();
        expect(trigger().hasAttribute("aria-controls")).toBe(false);
        open();
        expect(trigger().getAttribute("aria-controls")).toBe("refine-panel");
    });

    describe("placement", () => {
        const rect = (top: number, left: number, height: number, width: number) =>
            ({ top, left, bottom: top + height, right: left + width, height, width, x: left, y: top, toJSON() {} }) as DOMRect;
        let main: HTMLElement;
        let buttonRect: DOMRect;
        let wide = true;

        beforeEach(() => {
            wide = true;
            vi.stubGlobal("matchMedia", (q: string) => ({ matches: wide && q === "(min-width: 640px)", media: q }));
            vi.stubGlobal("innerWidth", 1280);
            vi.stubGlobal("innerHeight", 800);
            main = document.createElement("main");
            main.id = "main-content";
            host.replaceWith(main);
            main.appendChild(host);
            buttonRect = rect(284, 304, 44, 100);
            vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
                if (this.id === "main-content") return rect(64, 272, 632, 944); // ends at 696, above the player bar
                if (this.hasAttribute("aria-expanded")) return buttonRect;
                return rect(0, 0, 0, 0);
            });
        });

        afterEach(() => {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            document.body.appendChild(host);
            main.remove();
        });

        const vars = () => {
            const style = panel()!.style;
            return ["--refine-top", "--refine-left", "--refine-max-h"].map((v) => style.getPropertyValue(v));
        };

        it("sits under its button and ends inside the page's scrolling area", () => {
            show();
            open();
            // 284 + 44 + 8 = 336 down; 696 - 336 - 8 = 352 tall at most.
            expect(vars()).toEqual(["336px", "304px", "352px"]);
            expect(panel()!.getAttribute("role")).toBe("group");
        });

        it("keeps clear of the right edge", () => {
            buttonRect = rect(284, 1100, 44, 100);
            show();
            open();
            // 1280 - 384 - 16 = 880.
            expect(vars()[1]).toBe("880px");
        });

        it("closes when its button scrolls out of the page's scrolling area", () => {
            show();
            open();
            buttonRect = rect(30, 304, 44, 100);
            act(() => {
                main.dispatchEvent(new Event("scroll"));
            });
            expect(panel()).toBeNull();
            expect(trigger().getAttribute("aria-expanded")).toBe("false");
        });

        it("is a modal sheet on a phone, placed by CSS rather than measured", () => {
            wide = false;
            show();
            open();
            expect(panel()!.getAttribute("role")).toBe("dialog");
            expect(panel()!.getAttribute("aria-modal")).toBe("true");
            expect(vars()).toEqual(["0px", "0px", "0px"]);
        });
    });
});
