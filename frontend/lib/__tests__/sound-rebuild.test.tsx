/**
 * Whether the sound features are still being rebuilt is read from the work still owed, as the settings page reads it:
 * songs that failed for good or whose files are missing finish a step, they do not keep a rebuild going forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const progress = vi.fn();
vi.mock("@/lib/api", () => ({ api: { getEnrichmentProgress: () => progress() } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ isAuthenticated: true }) }));

import { useSoundRebuild, type SoundRebuild } from "@/hooks/useSoundRebuild";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let seen: SoundRebuild | null | undefined;

function Probe() {
    const rebuild = useSoundRebuild();
    React.useEffect(() => {
        seen = rebuild;
    });
    return null;
}

const step = (over: Record<string, number> = {}) => ({ total: 100, completed: 100, pending: 0, processing: 0, failed: 0, retrying: 0, ...over });

async function read(data: unknown) {
    progress.mockResolvedValue(data);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
        root.render(
            <QueryClientProvider client={client}>
                <Probe />
            </QueryClientProvider>,
        );
    });
    await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
    });
    return seen;
}

beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    seen = undefined;
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe("useSoundRebuild", () => {
    it("is done when the only songs left failed for good", async () => {
        const result = await read({
            clapEmbeddings: step({ completed: 97, failed: 3 }),
            moods: step(),
            similarity: step(),
            isFullyComplete: true,
        });
        expect(result).toBeNull();
    });

    it("is done when vectors are owed nothing even if the counts differ", async () => {
        const result = await read({
            clapEmbeddings: step({ completed: 90, failed: 10 }),
            moods: step({ completed: 90 }),
            similarity: step({ completed: 90 }),
            isFullyComplete: false,
        });
        expect(result).toBeNull();
    });

    it("says how far the vectors are while some are owed", async () => {
        const result = await read({
            clapEmbeddings: step({ completed: 40, pending: 55, processing: 5 }),
            moods: step(),
            similarity: step(),
            isFullyComplete: false,
        });
        expect(result).toEqual({ step: "vectors", done: 40, total: 100 });
    });

    it("moves on to moods once the vectors are owed nothing", async () => {
        expect(
            await read({ clapEmbeddings: step(), moods: step({ completed: 10, pending: 90 }), similarity: step(), isFullyComplete: false }),
        ).toEqual({ step: "moods", done: 10, total: 100 });
    });

    it("moves on to the map once the moods are owed nothing", async () => {
        expect(
            await read({ clapEmbeddings: step(), moods: step(), similarity: step({ completed: 10, pending: 90 }), isFullyComplete: false }),
        ).toEqual({ step: "map", done: 10, total: 100 });
    });
});
