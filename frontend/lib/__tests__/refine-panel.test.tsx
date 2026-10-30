/**
 * The collection's refine controls. On a phone, a sheet whose choices are radio groups: it says what is changed, resets
 * in one step, and closes when focus leaves it. Beside a phone, the same choices on the toolbar line.
 */
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { RefineBar, RefinePanel } from "@/features/library/components/RefinePanel";

const tv = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/tv-utils", () => ({ useIsTV: () => tv.on }));
import type { LibraryFilter, SortOption } from "@/hooks/useQueries";
import { mountHost } from "./helpers/dom";

const dom = mountHost();

function show(props: Partial<React.ComponentProps<typeof RefinePanel>> = {}) {
    const handlers = {
        onFilterChange: vi.fn<(f: LibraryFilter) => void>(),
        onSortChange: vi.fn<(s: SortOption) => void>(),
        onItemsPerPageChange: vi.fn<(n: number) => void>(),
        onReset: vi.fn<() => void>(),
    };
    act(() =>
        dom.root.render(
            <RefinePanel activeTab="albums" filter="owned" sortBy="name" itemsPerPage={40} {...handlers} {...props} />,
        ),
    );
    return handlers;
}

const trigger = () => dom.host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
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
        // Shift+Tab from the chosen sort stays inside: reset (and on a phone, close) come before it. From reset, the first
        // stop, it leaves.
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

    it("is a modal sheet with a close button", () => {
        show();
        open();
        expect(panel()!.getAttribute("role")).toBe("dialog");
        expect(panel()!.getAttribute("aria-modal")).toBe("true");
        const close = panel()!.querySelector<HTMLButtonElement>('[aria-label="Close refine panel"]')!;
        act(() => close.click());
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(trigger());
    });

    it("closes when the window widens past a phone's, where the controls sit on the toolbar line", () => {
        let onChange: (() => void) | undefined;
        const query = {
            matches: false,
            addEventListener: (_: string, fn: () => void) => (onChange = fn),
            removeEventListener: () => {},
        };
        vi.stubGlobal("matchMedia", () => query);
        try {
            show();
            open();
            expect(panel()).not.toBeNull();
            query.matches = true;
            act(() => onChange!());
            expect(panel()).toBeNull();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("RefineBar", () => {
    function showBar(props: Partial<React.ComponentProps<typeof RefineBar>> = {}) {
        const handlers = {
            onFilterChange: vi.fn<(f: LibraryFilter) => void>(),
            onSortChange: vi.fn<(s: SortOption) => void>(),
            onItemsPerPageChange: vi.fn<(n: number) => void>(),
            onReset: vi.fn<() => void>(),
        };
        act(() =>
            dom.root.render(
                <RefineBar activeTab="albums" filter="owned" sortBy="name" itemsPerPage={40} {...handlers} {...props} />,
            ),
        );
        return handlers;
    }
    const select = (label: string) =>
        [...dom.host.querySelectorAll("label")].find((l) => l.textContent?.startsWith(label))!.querySelector("select")!;
    const choose = (el: HTMLSelectElement, value: string) =>
        act(() => {
            el.value = value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
        });

    it("puts show, sort and page size on the line, with option text lowercased in source", () => {
        showBar();
        expect(dom.host.querySelector('[role="radiogroup"]')).not.toBeNull();
        expect([...select("Sort by").options].map((o) => o.textContent)).toEqual([
            "sort: name (a–z)",
            "sort: name (z–a)",
            "sort: year (newest)",
        ]);
        expect([...select("Per page").options].map((o) => o.textContent)).toEqual([
            "24 per page",
            "40 per page",
            "80 per page",
            "200 per page",
        ]);
        expect(select("Per page").value).toBe("40");
    });

    it("changes sort, page size and filter, and offers reset only once something is changed", () => {
        const { onSortChange, onItemsPerPageChange, onFilterChange } = showBar();
        expect([...dom.host.querySelectorAll("button")].some((b) => b.textContent === "Reset")).toBe(false);
        choose(select("Sort by"), "name-desc");
        expect(onSortChange).toHaveBeenLastCalledWith("name-desc");
        choose(select("Per page"), "200");
        expect(onItemsPerPageChange).toHaveBeenLastCalledWith(200);
        act(() => [...dom.host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((r) => r.textContent === "All")!.click());
        expect(onFilterChange).toHaveBeenLastCalledWith("all");

        const { onReset } = showBar({ itemsPerPage: 200 });
        const reset = [...dom.host.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
        act(() => reset.click());
        expect(onReset).toHaveBeenCalledTimes(1);
    });

    it("on a TV is a remote row of switches: the remote moves between buttons only, and owns the arrows", () => {
        tv.on = true;
        try {
            const { onSortChange, onItemsPerPageChange } = showBar();
            expect(dom.host.querySelector("select")).toBeNull();
            const groups = [...dom.host.querySelectorAll<HTMLElement>('[role="radiogroup"]')];
            expect(groups).toHaveLength(3);
            act(() => [...groups[1].querySelectorAll("button")].find((r) => r.textContent === "Name (Z–A)")!.click());
            expect(onSortChange).toHaveBeenLastCalledWith("name-desc");
            act(() => [...groups[2].querySelectorAll("button")].find((r) => r.textContent === "200 per page")!.click());
            expect(onItemsPerPageChange).toHaveBeenLastCalledWith(200);
            // Every choice a stop in the remote's row (the toolbar is the row), and the arrows left to the remote.
            expect(dom.host.querySelectorAll('[role="radio"][data-tv-card]')).toHaveLength(3 + 3 + 4);
            onSortChange.mockClear();
            act(() => {
                groups[1].querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
            });
            expect(onSortChange).not.toHaveBeenCalled();
        } finally {
            tv.on = false;
        }
    });

    it("hands focus to the row's first control when reset removes its own button", () => {
        const handlers = showBar({ filter: "all" });
        const reset = [...dom.host.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
        reset.focus();
        act(() => reset.click());
        expect(handlers.onReset).toHaveBeenCalledTimes(1);
        showBar({ filter: "owned", onReset: handlers.onReset });
        expect(document.activeElement?.textContent).toBe("In your library");
    });

    it("on the tracks tab, which has no filter, hands focus to the sort", () => {
        const handlers = showBar({ activeTab: "tracks", itemsPerPage: 80 });
        const reset = [...dom.host.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
        reset.focus();
        act(() => reset.click());
        showBar({ activeTab: "tracks", itemsPerPage: 40, onReset: handlers.onReset });
        expect(document.activeElement).toBe(select("Sort by"));
    });

    it("on a TV hands focus to the row's first switch, so the remote keeps working", () => {
        tv.on = true;
        try {
            const handlers = showBar({ activeTab: "tracks", sortBy: "name-desc" });
            const reset = [...dom.host.querySelectorAll("button")].find((b) => b.textContent === "Reset")!;
            reset.focus();
            act(() => reset.click());
            showBar({ activeTab: "tracks", sortBy: "name", onReset: handlers.onReset });
            expect(document.activeElement?.textContent).toBe("Name (A–Z)");
            expect(document.activeElement?.hasAttribute("data-tv-card")).toBe(true);
        } finally {
            tv.on = false;
        }
    });

    it("has no filter on the tracks tab", () => {
        showBar({ activeTab: "tracks" });
        expect(dom.host.querySelector('[role="radiogroup"]')).toBeNull();
    });

    it("says what the chosen filter shows, to screen readers and on hover", () => {
        showBar({ filter: "discovery" });
        const group = dom.host.querySelector('[role="radiogroup"]')!;
        expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toBe(
            "Albums suggested by your listening history",
        );
        expect(group.getAttribute("title")).toBe("albums suggested by your listening history");
    });
});
