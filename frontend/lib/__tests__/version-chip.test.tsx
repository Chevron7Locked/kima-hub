/**
 * The version chip's "· N open" reads the server's count and reads it again once something settles an item, in the
 * top bar and the phone menu alike (one hook). Before, each fetched once per page load and went stale.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const counts = [2, 0];
vi.mock("@/lib/api", () => ({
    api: {
        get: vi.fn(async () => ({ count: counts.shift() ?? 0 })),
        getUpdateStatus: vi.fn(async () => ({ hasUpdate: false, latest: null })),
    },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

import { refreshOpenCount, useVersionChip } from "@/components/whats-new/useVersionChip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Chip() {
    const chip = useVersionChip();
    return <span>{chip.label}</span>;
}

beforeEach(() => {
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
    await act(async () => root.render(<QueryClientProvider client={client}><Chip /></QueryClientProvider>));
    await settle();
    expect(container.textContent).toMatch(/— 2 open$/);
    await act(async () => refreshOpenCount(client));
    await settle();
    expect(container.textContent).not.toMatch(/open/);
});
