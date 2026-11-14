/** The share page's request for the share is cancelled when the page goes away, and a cancelled request is not shown as a failure. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

let token = "tok";
vi.mock("next/navigation", () => ({ useParams: () => ({ token }) }));

import SharePageClient from "@/app/share/[token]/SharePageClient";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** The share token in a resolve address ("/api/share/<token>"). */
const tokenOf = (url: string) => decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");

let root: Root;
let host: HTMLDivElement;
let signal: AbortSignal | undefined;
// What the server answers for a share token; a token with no entry never gets an answer.
let answers: Record<string, unknown> = {};
// Tokens the server answers with "not found".
let missing: string[] = [];

beforeEach(() => {
    token = "tok";
    signal = undefined;
    answers = {};
    missing = [];
    vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
            signal = init?.signal ?? undefined;
            if (missing.includes(tokenOf(url))) {
                return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "Share link not found" }) });
            }
            const answered = Object.entries(answers).find(([tok]) => tok === tokenOf(url));
            if (answered) return Promise.resolve({ ok: true, status: 200, json: async () => answered[1] });
            return new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            });
        }),
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    vi.unstubAllGlobals();
    host.remove();
});

describe("SharePageClient", () => {
    it("asks for the share with a cancellable request, and cancels it when the page unmounts", async () => {
        await act(async () => root.render(<SharePageClient />));
        expect(signal).toBeDefined();
        expect(signal!.aborted).toBe(false);

        await act(async () => root.unmount());

        expect(signal!.aborted).toBe(true);
    });

    it("does not show a cancelled request as a load failure when the page moves to another share", async () => {
        await act(async () => root.render(<SharePageClient />));
        const first = signal!;
        const before = host.textContent;

        token = "other";
        await act(async () => root.render(<SharePageClient />));

        expect(first.aborted).toBe(true);
        expect(signal).not.toBe(first);
        expect(host.textContent).toBe(before);
        await act(async () => root.unmount());
    });

    it("shows nothing of the old share under a new link: the page goes back to loading", async () => {
        answers = { tok: { entityType: "album", entity: { id: "a1", title: "First Album", artist: { name: "First Artist" }, tracks: [] } } };
        await act(async () => root.render(<SharePageClient />));
        expect(host.textContent).toContain("First Album");

        // The new share has not answered yet.
        token = "other";
        await act(async () => root.render(<SharePageClient />));
        expect(host.textContent).not.toContain("First Album");
        expect(host.textContent).not.toContain("First Artist");
        await act(async () => root.unmount());
    });

    it("does not show the failure of the old link under a new one", async () => {
        missing = ["tok"];
        await act(async () => root.render(<SharePageClient />));
        expect(host.textContent).toContain("Share link not found");

        token = "other";
        await act(async () => root.render(<SharePageClient />));
        expect(host.textContent).not.toContain("Share link not found");
        await act(async () => root.unmount());
    });
});
