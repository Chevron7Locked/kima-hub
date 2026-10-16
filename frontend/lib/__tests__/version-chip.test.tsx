/**
 * The version chip's hook (useVersionChip, used by the top bar and the phone menu) shows the server's open count and
 * reads it again once something settles an item.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act, useEffect } from "react";

/** What the server answers for the open count, whenever it is asked. */
let serverCount = 0;
vi.mock("@/lib/api", () => ({
    api: {
        get: vi.fn(async () => ({ count: serverCount })),
        getUpdateStatus: vi.fn(async () => ({ hasUpdate: false, latest: null })),
    },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

import { refreshOpenCount, useVersionChip } from "@/components/whats-new/useVersionChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let shown: ReturnType<typeof useVersionChip> | null = null;

function Chip() {
    const chip = useVersionChip();
    useEffect(() => {
        shown = chip;
    });
    return <span>{chip.label}</span>;
}

beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

it("shows the open count, and the new one after something settles", async () => {
    serverCount = 2;
    await act(async () => root.render(<QueryClientProvider client={client}><Chip /></QueryClientProvider>));
    await settle();
    expect(shown?.openCount).toBe(2);
    expect(container.textContent).toMatch(/— 2 open$/);

    serverCount = 0;
    await act(async () => refreshOpenCount(client));
    await settle();
    expect(shown?.openCount).toBe(0);
    expect(container.textContent).not.toMatch(/open/);
});

it("keeps the count it has until something settles", async () => {
    serverCount = 3;
    await act(async () => root.render(<QueryClientProvider client={client}><Chip /></QueryClientProvider>));
    await settle();
    serverCount = 1;
    await settle();
    expect(shown?.openCount).toBe(3);
});
