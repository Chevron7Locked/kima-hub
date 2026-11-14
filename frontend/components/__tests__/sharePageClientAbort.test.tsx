/** The share page's request for the share is cancelled when the page goes away, and a cancelled request is not shown as a failure. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

let token = "tok";
vi.mock("next/navigation", () => ({ useParams: () => ({ token }) }));

import SharePageClient from "@/app/share/[token]/SharePageClient";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let signal: AbortSignal | undefined;

beforeEach(() => {
    token = "tok";
    signal = undefined;
    vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
            signal = init?.signal ?? undefined;
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
});
