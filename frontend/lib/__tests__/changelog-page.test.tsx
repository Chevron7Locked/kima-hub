// The changelog page renders the ledger honestly: notes verbatim, open stays open, dismissed looks dismissed,
// and answered says who answered. The API is canned here; the live contract is pinned server-side.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));
vi.mock("@/lib/notify", () => ({ notify: { info: vi.fn(), error: vi.fn() } }));

const changelog = {
    openCount: 1,
    releases: [
        {
            version: "1.12.0",
            title: "Kima 1.12",
            summary: "Rerun from any step and fixes.",
            date: "2026-10-13",
            dismissed: false,
            items: [
                { key: "enrichment.rerun", kind: "note", title: "Rerun from any step", summary: "Redo a step, get a fresh map.", body: "Each rerun makes a fresh map." },
                { key: "albums.refile", kind: "action", title: "Re-file albums by their tags", summary: "Puts albums back.", body: "Reads every song's tags again.", cta: "Re-file albums", run: "refileAlbums", open: false, done: true },
            ],
        },
        {
            version: "1.11.0",
            title: "Kima 1.11",
            summary: "The new vibe engine.",
            date: "2026-10-12",
            note: { from: "Kevin", body: "Hey y'all.\n\nI love you." },
            dismissed: true,
            items: [
                { key: "engine.wipe", kind: "action", title: "Wipe and re-run enrichment", summary: "One fresh run.", body: "Everything the old engine worked out.", cta: "Wipe and re-run", run: "wipeEnrichment", open: true, done: false },
                { key: "gpu.accelerate", kind: "choice", title: "Use an NVIDIA graphics card", summary: "Optional.", body: "Runs on the card.", answer: { enabled: false, decidedBy: "DISMISSED" } },
                { key: "vibe.engine", kind: "note", title: "The new vibe engine", summary: "Sound, feel, genre.", body: "Every match weighs three things." },
            ],
        },
    ],
};

vi.mock("@/lib/api", () => ({
    api: { get: vi.fn(async () => changelog), post: vi.fn(async () => ({})), refileAlbums: vi.fn(async () => ({})), wipeAndRerunEnrichment: vi.fn(async () => ({})), getAnalysisTogether: vi.fn(async () => ({ together: false })), setAnalysisTogether: vi.fn() },
}));

import ChangelogPage from "@/app/changelog/page";
import { api } from "@/lib/api";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
});

afterEach(() => {
    act(() => root?.unmount());
});

/** Renders the page and waits for the changelog to arrive; returns the query client it used. */
async function render(client = new QueryClient()) {
    root = createRoot(container);
    await act(async () => {
        root.render(<QueryClientProvider client={client}><ChangelogPage /></QueryClientProvider>);
    });
    // The query hands its answer over on a timer, after the first flush.
    for (let i = 0; i < 50 && container.textContent?.includes("Loading the changelog"); i++) {
        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });
    }
    return client;
}

const click = async (el: Element | null | undefined) =>
    act(async () => {
        (el as HTMLElement).click();
    });
const buttonNamed = (text: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
const wipeItem = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Wipe and re-run enrichment"));
const confirmWipe = () =>
    click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.trim() === "Wipe and re-run"));

describe("/changelog", () => {
    it("stacks releases newest first with 1.11's note preserved verbatim", async () => {
        await render();
        const sections = container.querySelectorAll("section[id]");
        expect(sections[0].id).toBe("1.12.0");
        expect(container.textContent).toContain("Hey y'all.");
        expect(container.textContent).toContain("I love you.");
        expect(container.querySelector('[id="1.11.0"]')).not.toBeNull();
    });

    it("shows the quiet open ledger and the honest state of every answered question", async () => {
        await render();
        expect(container.textContent).toContain("One thing is still open");
        expect(container.textContent).toContain("Wipe and re-run enrichment");
        // Open until verifiably done; the record says it plainly.
        expect(container.textContent).toContain("They close themselves when they truly happen.");
        // An unanswered dismissal reads as silence, not consent.
        const toggle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("NVIDIA"))!;
        expect(toggle.textContent).toContain("off, unanswered");
    });

    it("keeps the re-file's button after it has run: it can be run again any time", async () => {
        await render();
        const toggle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Re-file albums by their tags"))!;
        await act(async () => {
            toggle.click();
        });
        expect(buttonNamed("Re-file albums")).toBeTruthy();
        expect(container.textContent).toContain("Albums were re-filed before. Running it again is safe.");
    });

    it("expands an item to its full body and its run control", async () => {
        await render();
        const toggle = wipeItem()!;
        await act(async () => {
            toggle.click();
        });
        expect(container.textContent).toContain("Everything the old engine worked out.");
        const run = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Wipe and re-run")!;
        expect(run).toBeTruthy();
        // Beside the wipe, the choice of running both heavy jobs at once, off until an admin turns it on.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });
        const both = container.querySelector<HTMLInputElement>("#whats-new-analysis-together");
        expect(both).not.toBeNull();
        expect(both!.checked).toBe(false);
        expect(container.textContent).toContain("Run audio analysis and sound vectors at the same time");
    });

    it("asks before wiping, then says the run started; a failure says so and leaves the button", async () => {
        const wipe = vi.mocked(api.wipeAndRerunEnrichment);
        await render();
        await click(wipeItem());

        wipe.mockRejectedValueOnce(new Error("down"));
        await click(container.querySelector<HTMLElement>('[data-testid="wipe-run"]')!);
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        // Drawn at the page's top level, never inside the window or page that asked.
        expect(container.contains(document.querySelector('[role="dialog"]'))).toBe(false);
        expect(wipe).not.toHaveBeenCalled();
        await confirmWipe();
        expect(wipe).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain("Couldn't start it.");
        expect(container.querySelector('[data-testid="wipe-run"]')).not.toBeNull();

        await click(container.querySelector<HTMLElement>('[data-testid="wipe-run"]')!);
        await confirmWipe();
        expect(wipe).toHaveBeenCalledTimes(2);
        expect(container.querySelector('[data-testid="wipe-started"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="wipe-run"]')).toBeNull();
        expect(buttonNamed("Not now")).toBeUndefined();
    });

    it("shows a wipe still starting after the item is closed and opened again, and never sends a second", async () => {
        const wipe = vi.mocked(api.wipeAndRerunEnrichment);
        wipe.mockClear();
        let finish = () => {};
        wipe.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ artists: 0, tracks: 0, vectors: 0 }))));
        await render();
        await click(wipeItem());
        await click(container.querySelector('[data-testid="wipe-run"]'));
        await confirmWipe();
        expect(wipe).toHaveBeenCalledTimes(1);

        await click(wipeItem());
        await click(wipeItem());
        const run = container.querySelector<HTMLButtonElement>('[data-testid="wipe-run"]')!;
        expect(run.disabled).toBe(true);
        expect(run.textContent).toContain("Starting");
        await click(run);
        expect(wipe).toHaveBeenCalledTimes(1);

        await act(async () => finish());
        expect(container.querySelector('[data-testid="wipe-started"]')).not.toBeNull();
    });

    it("tells a reopened wipe control that the request failed, and offers it again", async () => {
        const wipe = vi.mocked(api.wipeAndRerunEnrichment);
        wipe.mockClear();
        let fail = () => {};
        wipe.mockImplementationOnce(() => new Promise((_, reject) => (fail = () => reject(new Error("down")))));
        await render();
        await click(wipeItem());
        await click(container.querySelector('[data-testid="wipe-run"]'));
        await confirmWipe();
        await click(wipeItem());
        await click(wipeItem());
        await act(async () => fail());
        expect(container.textContent).toContain("Couldn't start it.");
        const run = container.querySelector<HTMLButtonElement>('[data-testid="wipe-run"]')!;
        expect(run.disabled).toBe(false);
    });

    it("Escape closes only the wipe confirm, and focus goes back to the button that opened it", async () => {
        await render();
        await act(async () => {
            wipeItem()!.click();
        });
        const run = container.querySelector<HTMLButtonElement>('[data-testid="wipe-run"]')!;
        run.focus();
        await act(async () => {
            run.click();
        });
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(dialog).not.toBeNull();
        const behind = vi.fn();
        window.addEventListener("keydown", behind);
        await act(async () => {
            (document.activeElement ?? dialog).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        window.removeEventListener("keydown", behind);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(behind).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(container.querySelector('[data-testid="wipe-run"]'));
    });

    it("a deep link opens that release's items, and a reload of the list keeps what the reader then closed", async () => {
        window.history.replaceState(null, "", "/changelog#1.11.0");
        const client = await render();
        const toggleOf = (key: string) =>
            Array.from(document.getElementById("1.11.0")!.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((b) => b.textContent?.includes(key))!;
        expect(toggleOf("Wipe and re-run enrichment").getAttribute("aria-expanded")).toBe("true");

        await act(async () => toggleOf("Wipe and re-run enrichment").click());
        expect(toggleOf("Wipe and re-run enrichment").getAttribute("aria-expanded")).toBe("false");

        // The reload after the wipe settled: the item now says done.
        const settled = structuredClone(changelog);
        Object.assign(settled.releases[1].items[0], { open: false, done: true });
        vi.mocked(api.get).mockResolvedValueOnce(settled);
        const asked = vi.mocked(api.get).mock.calls.length;
        await act(async () => {
            await client.invalidateQueries({ queryKey: ["whats-new", "changelog"] });
            // The answer reaches the page on a timer.
            await new Promise((r) => setTimeout(r, 20));
        });
        expect(vi.mocked(api.get).mock.calls.length).toBe(asked + 1);
        expect(toggleOf("Wipe and re-run enrichment").textContent).toContain("done");
        expect(toggleOf("Wipe and re-run enrichment").getAttribute("aria-expanded")).toBe("false");
        window.history.replaceState(null, "", "/changelog");
    });
});
