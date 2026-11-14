/**
 * The share page: its request for the share is cancelled when the page goes away (a cancelled request is not shown as a
 * failure), a new link starts from nothing, its audio stops when it goes away, and a failure reads from the status the
 * server answered with.
 */
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
// Tokens the server refuses with a status and a message; the message is the backend's own wording.
let refused: Record<string, { status: number; error?: string }> = {};

beforeEach(() => {
    token = "tok";
    signal = undefined;
    answers = {};
    missing = [];
    refused = {};
    vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
            signal = init?.signal ?? undefined;
            if (missing.includes(tokenOf(url))) {
                return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "Share link not found" }) });
            }
            const refusal = refused[tokenOf(url)];
            if (refusal) {
                return Promise.resolve({
                    ok: false,
                    status: refusal.status,
                    json: async () => (refusal.error ? { error: refusal.error } : Promise.reject(new SyntaxError("not json"))),
                });
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

    it("stops the audio and clears its source when the page goes away", async () => {
        answers = { tok: { entityType: "album", entity: { id: "a1", title: "First Album", artist: { name: "First Artist" }, tracks: [] } } };
        const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
        await act(async () => root.render(<SharePageClient />));
        const audio = host.querySelector("audio")!;
        expect(audio).not.toBeNull();
        audio.src = "http://localhost/api/share/tok/stream/t1";

        await act(async () => root.unmount());

        expect(pause).toHaveBeenCalled();
        expect(audio.getAttribute("src")).toBe("");
        pause.mockRestore();
    });

    describe("a failure to open the share reads from the status", () => {
        const opened = async () => {
            await act(async () => root.render(<SharePageClient />));
            const text = host.textContent ?? "";
            await act(async () => root.unmount());
            return text;
        };

        it("404 is a link that is not found", async () => {
            refused = { tok: { status: 404, error: "Share link not found" } };
            expect(await opened()).toContain("Share link not found");
        });

        it("410 is a link that has ended: expired or out of plays, which the server does not tell apart by status", async () => {
            refused = { tok: { status: 410, error: "Share link play limit reached" } };
            expect(await opened()).toContain("This link has expired or reached its play limit");
        });

        it("429 is too many requests, not a link that reached its play limit", async () => {
            refused = { tok: { status: 429, error: "Too many requests from this IP, please try again later." } };
            const text = await opened();
            expect(text).toContain("Too many requests");
            expect(text).not.toContain("play limit");
        });

        it("any other answer, with or without a readable body, is a general failure", async () => {
            refused = { tok: { status: 500 } };
            expect(await opened()).toContain("Couldn't open this share");
        });

        it("the page's wording follows the status, not the words in the server's message", async () => {
            refused = { tok: { status: 500, error: "the link has expired, the limit is reached" } };
            expect(await opened()).toContain("Couldn't open this share");
        });

        it("a request that never got an answer is a general failure", async () => {
            vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
            expect(await opened()).toContain("Couldn't open this share");
        });
    });
});
