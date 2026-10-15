// The release window's layout contract, in jsdom: exactly one active view below `lg`. Both panes may only ever
// hide below a breakpoint — never both at once at base.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/lib/api", () => ({
    api: { get: vi.fn(async () => ({})), post: vi.fn(async () => ({})) },
}));
vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));

import { WhatsNewWindow, type Release } from "@/components/whats-new/WhatsNewWindow";

const R11: Release = {
    version: "1.11.0",
    title: "Kima 1.11",
    summary: "The new vibe engine.",
    date: "2026-10-12",
    note: { from: "Kevin", body: "Hey y'all.\n\nI love you." },
    items: [
        {
            kind: "action",
            key: "moods.mixes",
            title: "Your mood mix",
            summary: "Rebuild it, keep it, or save it.",
            body: "Your saved mood mix was picked from the old moods.",
            cta: "Rebuild",
            ifClosed: "If you close now, your mood mix stays as it is.",
        },
        { kind: "note", key: "vibe.engine", title: "The new vibe engine", summary: "Sound, feel, genre.", body: "Every match weighs three things." },
    ],
};

const R12: Release = {
    version: "1.12.0",
    title: "Kima 1.12",
    summary: "Rerun from any step and fixes.",
    date: "2026-10-13",
    items: [
        { kind: "note", key: "enrichment.rerun", title: "Rerun from any step", summary: "Redo a step, get a fresh map.", body: "Each rerun makes a fresh map.", links: [{ label: "Open Settings", href: "/settings" }] },
    ],
};

let container: HTMLDivElement;
let root: Root;

async function renderWindow(releases: Release[]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(
            <QueryClientProvider client={new QueryClient()}>
                <WhatsNewWindow releases={releases} onClose={() => {}} onDismiss={async () => {}} />
            </QueryClientProvider>,
        );
    });
}

const panes = () => Array.from(container.querySelectorAll<HTMLElement>("div.overflow-y-auto"));
// A `hidden` with no `lg:block` escape means the pane is invisible at every width.
const hiddenEverywhere = (el: HTMLElement) => el.classList.contains("hidden") && !el.classList.contains("lg:block");

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("WhatsNewWindow", () => {
    it("stacks older unread releases as one line each under a Before-this heading", async () => {
        await renderWindow([R11, R12]);
        expect(container.textContent).toContain("Before this");
        const row = container.querySelector('[data-release="1.11.0"]');
        expect(row?.textContent).toContain("Kima 1.11");
        expect(row?.textContent).toContain("a note from Kevin");
        // 1.11's items are not dumped into the 1.12 list — only their release line is.
        const list = container.querySelector("#whats-new-list")!;
        expect(list.textContent).not.toContain("Your mood mix");
    });

    it("opens an older release's read page with its note verbatim, and returns", async () => {
        await renderWindow([R11, R12]);
        const row = container.querySelector<HTMLButtonElement>('[data-release="1.11.0"]')!;
        await act(async () => {
            row.click();
        });
        expect(container.textContent).toContain("Hey y'all.");
        expect(container.textContent).toContain("I love you.");
        const back = container.querySelector<HTMLButtonElement>("[data-back]")!;
        await act(async () => {
            back.click();
        });
        expect(container.querySelector('[data-release="1.11.0"]')).not.toBeNull();
    });

    it("returns from an older release's item to that release's page, focused on the item", async () => {
        await renderWindow([R11, R12]);
        const click = async (selector: string) =>
            act(async () => {
                container.querySelector<HTMLButtonElement>(selector)!.click();
            });
        await click('[data-release="1.11.0"]');
        await click('[data-item="vibe.engine"]');
        expect(container.querySelector("#whats-new-item")?.textContent).toBe("The new vibe engine");
        await click("[data-back]");
        expect(container.querySelector("#whats-new-release")?.textContent).toBe("Kima 1.11");
        expect(document.activeElement?.getAttribute("data-item")).toBe("vibe.engine");
        // Back again from the release page is the list.
        await click("[data-back]");
        expect(container.querySelector("#whats-new-release")).toBeNull();
        expect(document.activeElement?.getAttribute("data-release")).toBe("1.11.0");
    });

    it("never hides both panes at once, in any view", async () => {
        await renderWindow([R11, R12]);
        const check = () => {
            const p = panes();
            expect(p.length).toBe(2);
            expect(hiddenEverywhere(p[0]) && hiddenEverywhere(p[1])).toBe(false);
        };
        check(); // list
        await act(async () => {
            container.querySelector<HTMLButtonElement>('[data-release="1.11.0"]')!.click();
        });
        check(); // release read page
        await act(async () => {
            container.querySelector<HTMLButtonElement>("[data-back]")!.click();
        });
        check();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('[data-item="enrichment.rerun"]')!.click();
        });
        check(); // item page
        await act(async () => {
            container.querySelector<HTMLButtonElement>("[data-back]")!.click();
        });
        check();
        await act(async () => {
            container.querySelector<HTMLButtonElement>('[data-testid="whatsnew-waiting"]')!.click();
        });
        check(); // needs page
    });

    it("shows a release without a note an intro instead of a missing note", async () => {
        await renderWindow([R12]);
        expect(container.textContent).toContain("Rerun from any step and fixes.");
        expect(container.textContent).not.toContain("A note from");
    });
});
