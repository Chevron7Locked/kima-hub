/**
 * The pending releases are fetched once per sign-in and kept across the gate remounting: someone who signs in after
 * another person, without a reload, gets their own, never the other person's; signing in again reads them afresh.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

let user: { id: string } | null = { id: "u1" };
let token = "session-1";
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user }) }));
const get = vi.fn();
vi.mock("@/lib/api", () => ({ api: { get: (...a: unknown[]) => get(...a), post: vi.fn(async () => ({})), getToken: () => token } }));
vi.mock("@/lib/notify", () => ({ notify: { info: vi.fn(), error: vi.fn() } }));
vi.mock("next/link", () => ({
    default: ({ children, href, ...rest }: { children?: React.ReactNode; href: string; [k: string]: unknown }) =>
        React.createElement("a", { href, ...rest }, children),
}));

import { WhatsNewGate } from "@/components/whats-new/WhatsNewGate";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const release = (version: string, title: string) => ({ version, title, summary: "s", date: "2026-10-13", items: [] });

let host: HTMLDivElement;
let root: Root;
const show = () =>
    act(async () => {
        root.render(<QueryClientProvider client={new QueryClient()}><WhatsNewGate /></QueryClientProvider>);
    });
const hide = () => act(async () => root.render(<></>));

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    get.mockImplementation(async () => ({ releases: [release("1.12.0", `for ${user?.id}`)] }));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("WhatsNewGate", () => {
    it("asks once per user across remounts, and asks again for the next user", async () => {
        await show();
        expect(document.body.textContent).toContain("for u1");
        await hide();
        await show();
        expect(get.mock.calls.filter(([path]) => path === "/whats-new/pending")).toHaveLength(1);

        await hide();
        user = { id: "u2" };
        await show();
        expect(get.mock.calls.filter(([path]) => path === "/whats-new/pending")).toHaveLength(2);
        expect(document.body.textContent).toContain("for u2");
        expect(document.body.textContent).not.toContain("for u1");

        await hide();
        token = "session-2";
        await show();
        expect(get.mock.calls.filter(([path]) => path === "/whats-new/pending")).toHaveLength(3);
    });
});
