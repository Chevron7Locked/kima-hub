// The changelog page renders the ledger honestly: notes verbatim, open stays open, dismissed looks dismissed,
// and answered says who answered. The API is canned here; the live contract is pinned server-side.

import { describe, it, expect, vi, beforeEach } from "vitest";
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
            items: [{ key: "enrichment.rerun", kind: "note", title: "Rerun from any step", summary: "Redo a step, get a fresh map.", body: "Each rerun makes a fresh map." }],
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
    api: { get: vi.fn(async () => changelog), post: vi.fn(async () => ({})), wipeAndRerunEnrichment: vi.fn(async () => ({})) },
}));

import ChangelogPage from "@/app/changelog/page";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
});

async function render() {
    root = createRoot(container);
    await act(async () => {
        root.render(<ChangelogPage />);
    });
}

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

    it("expands an item to its full body and its run control", async () => {
        await render();
        const toggle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Wipe and re-run enrichment"))!;
        await act(async () => {
            toggle.click();
        });
        expect(container.textContent).toContain("Everything the old engine worked out.");
        const run = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Wipe and re-run")!;
        expect(run).toBeTruthy();
    });
});
