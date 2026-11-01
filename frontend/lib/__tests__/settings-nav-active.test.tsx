/**
 * The settings menu marks the section being read. A clicked section stays marked while the page scrolls to it, even
 * when it sits too near the bottom to reach the top; scrolled all the way down, the last section is the one marked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { SettingsLayout } from "@/features/settings/components/ui/SettingsLayout";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const items = [
    { id: "account", label: "Account" },
    { id: "corrupt", label: "Corrupt tracks" },
    { id: "users", label: "Users" },
];

// Section tops relative to the scroll container's top (0); 150 px down counts as "being read".
let tops: Record<string, number>;
let scroller: HTMLDivElement;
const metrics = { scrollTop: 0, scrollHeight: 3000, clientHeight: 800 };
// Animation frames run when the test says a frame has passed.
const frames: FrameRequestCallback[] = [];
const nextFrame = () => {
    for (const cb of frames.splice(0)) cb(0);
};

beforeEach(() => {
    frames.length = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
    });
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        const top = this.id in tops ? tops[this.id] : 0;
        return { top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON() {} } as DOMRect;
    });
});

const nativeScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Element.prototype.scrollIntoView = nativeScrollIntoView;
});

function show() {
    scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    for (const k of ["scrollHeight", "clientHeight"] as const) {
        Object.defineProperty(scroller, k, { configurable: true, get: () => metrics[k] });
    }
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => metrics.scrollTop });
    document.body.appendChild(scroller);
    tops = { account: 0, corrupt: 600, users: 1400 };
    const inner = document.createElement("div");
    scroller.appendChild(inner);
    return inner;
}

const marked = () =>
    [...document.querySelectorAll<HTMLButtonElement>("nav button")]
        .filter((b) => b.getAttribute("aria-current") === "true")
        .map((b) => b.textContent);

function scrollTo(next: Record<string, number>, scrollTop: number) {
    tops = next;
    metrics.scrollTop = scrollTop;
    act(() => {
        scroller.dispatchEvent(new Event("scroll"));
        nextFrame();
    });
}

describe("settings menu", () => {
    let root: Root;

    beforeEach(() => {
        const inner = show();
        root = createRoot(inner);
        act(() =>
            root.render(
                <SettingsLayout sidebarItems={items} isAdmin={false}>
                    {items.map((i) => (
                        <section key={i.id} id={i.id} />
                    ))}
                </SettingsLayout>,
            ),
        );
    });

    afterEach(() => {
        act(() => root.unmount());
        scroller.remove();
        metrics.scrollTop = 0;
    });

    it("marks the first section at the top", () => {
        expect(marked()).toEqual(["Account"]);
    });

    it("keeps a clicked section marked while the page scrolls to it", () => {
        const users = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find((b) => b.textContent === "Users")!;
        act(() => users.click());
        expect(marked()).toEqual(["Users"]);
        // The smooth scroll ends at the bottom, with "users" still 400 px down: too low to count by position.
        scrollTo({ account: -2200, corrupt: 100, users: 400 }, 2200);
        expect(marked()).toEqual(["Users"]);
    });

    it("marks by position again once the reader moves the page from where the jump came to rest", () => {
        vi.useFakeTimers();
        const users = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find((b) => b.textContent === "Users")!;
        act(() => users.click());
        scrollTo({ account: -2200, corrupt: 100, users: 400 }, 2200);
        // Trackpad momentum after the jump is still the jump: it only comes to rest once scrolling stops.
        act(() => vi.advanceTimersByTime(100));
        scrollTo({ account: -2210, corrupt: 90, users: 390 }, 2210);
        act(() => vi.advanceTimersByTime(200));
        expect(marked()).toEqual(["Users"]);
        // A nudge of a few pixels keeps it.
        scrollTo({ account: -2200, corrupt: 100, users: 400 }, 2200);
        expect(marked()).toEqual(["Users"]);
        scrollTo({ account: -500, corrupt: 100, users: 900 }, 500);
        expect(marked()).toEqual(["Corrupt tracks"]);
    });

    it("marks the last section when scrolled to the bottom", () => {
        scrollTo({ account: -2200, corrupt: 100, users: 400 }, 2200);
        expect(marked()).toEqual(["Users"]);
    });
});

describe("settings menu on a page too short to scroll", () => {
    it("marks the first section, not the last", () => {
        metrics.scrollHeight = 800;
        const inner = show();
        const root = createRoot(inner);
        act(() =>
            root.render(
                <SettingsLayout sidebarItems={items} isAdmin={false}>
                    {items.map((i) => (
                        <section key={i.id} id={i.id} />
                    ))}
                </SettingsLayout>,
            ),
        );
        expect(marked()).toEqual(["Account"]);
        act(() => root.unmount());
        scroller.remove();
        metrics.scrollHeight = 3000;
    });
});
