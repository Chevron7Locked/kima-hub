/**
 * The first-scan page says the scan did not finish when it fails, shows the error once, and never says "ready".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api", () => ({
    api: {
        scanLibrary: vi.fn(async () => ({ jobId: "scan-1" })),
        getScanStatus: vi.fn(async () => ({ status: "failed", progress: 0, error: "disk gone" })),
    },
}));

import SyncPage from "@/app/sync/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

it("a failed scan reads as not finished, with the error shown once", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><SyncPage /></QueryClientProvider>));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const text = container.textContent ?? "";
    expect(container.querySelector("h2")?.textContent).toBe("Sync Didn't Finish");
    expect(text).not.toMatch(/ready/i);
    expect(text.split("Scan failed.").length - 1).toBe(1);
});
