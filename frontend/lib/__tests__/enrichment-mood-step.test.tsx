/**
 * The Library Enrichment section shows the mood step between vibe embeddings and similarity, names the step a run is
 * on in the list's words, and the moods re-run says the vibe map stays (it is the one step that does not lay it out).
 * Its maintenance operations offer re-filing albums by their tags, after a confirmation.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const progress = {
    source: "TrackStage",
    artists: { total: 10, completed: 10, pending: 0, failed: 0, progress: 100 },
    trackTags: { total: 100, enriched: 100, pending: 0, waiting: 0, waitingMissing: 0, progress: 100 },
    audioAnalysis: {
        total: 100, completed: 100, pending: 0, queued: 0, processing: 0, failed: 0, permanentlyFailed: 0,
        waitingMissing: 0, progress: 100, isBackground: true,
    },
    clapEmbeddings: {
        total: 100, completed: 100, pending: 0, processing: 0, failed: 0, retrying: 0, waitingMissing: 0, progress: 100,
        isBackground: true,
    },
    fingerprints: {
        total: 100, completed: 97, pending: 0, processing: 0, failed: 3, waitingMissing: 0, progress: 97,
        isBackground: true,
    },
    moods: { total: 100, completed: 40, pending: 60, progress: 40, isBackground: true },
    similarity: { total: 100, completed: 0, pending: 100, progress: 0, isBackground: true },
    coreComplete: true,
    isFullyComplete: false,
};

const rerun = vi.fn();
const refile = vi.fn();

vi.mock("@/lib/api", () => ({
    api: {
        getEnrichmentState: async () => ({ status: "running", currentPhase: "mood", hung: false }),
        getEnrichmentProgress: async () => progress,
        getEnrichmentFailureCounts: async () => ({ total: 0 }),
        getEnrichmentFailures: async () => ({ failures: [] }),
        getEnrichmentConcurrency: async () => ({ concurrency: 1 }),
        getAnalysisWorkers: async () => ({ workers: 2, cpuCores: 8 }),
        getClapWorkers: async () => ({ workers: 1, cpuCores: 8 }),
        getGpuStatus: async () => ({ supported: false }),
        rerunEnrichment: (...a: unknown[]) => rerun(...a),
        refileAlbums: (...a: unknown[]) => refile(...a),
    },
}));
vi.mock("@/lib/features-context", () => ({
    useFeatures: () => ({ musicCNN: true, vibeEmbeddings: true, loading: false }),
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
vi.mock("@/components/enrichment/BothAtOnceSwitch", () => ({
    BothAtOnceSwitch: () => null,
    BOTH_AT_ONCE_LABEL: "",
    BOTH_AT_ONCE_DESCRIPTION: "",
}));

import { CacheSection, backgroundStepRunning, phaseLabel } from "@/features/settings/components/sections/CacheSection";
import type { SystemSettings } from "@/features/settings/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
});

async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const settings = { transcodeCacheMaxGb: 5 } as SystemSettings;
    await act(async () => {
        root.render(<QueryClientProvider client={client}><CacheSection settings={settings} onUpdate={() => {}} /></QueryClientProvider>);
    });
    await settle();
    await settle();
}

describe("the enrichment steps", () => {
    it("show Moods between Vibe Embeddings and Similarity, with its count", async () => {
        await render();
        const text = container.textContent ?? "";
        const steps = Array.from(container.querySelectorAll("span.text-sm.font-medium")).map((s) => s.textContent);
        expect(steps).toEqual([
            "Artist Metadata", "Song Identification", "Fingerprints", "Audio Analysis", "Vibe Embeddings", "Moods",
            "Similarity",
        ]);
        expect(text).toContain("40 / 100");
        expect(text).toContain("97 / 100");
        expect(text).toContain("3 failed");
        expect(text).toContain("Moods running");
        expect(text).toContain("Processing moods...");
    });

    it("say the vibe map stays when the moods are re-run, and is laid out again for the others", async () => {
        await render();
        const select = container.querySelector("[data-testid=enrichment-rerun-select]") as HTMLSelectElement;
        const rerunButton = container.querySelector("[data-testid=enrichment-rerun]") as HTMLButtonElement;

        await act(async () => {
            select.value = "moods";
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await act(async () => rerunButton.click());
        expect(document.body.textContent).toContain("The vibe map stays as it is.");
        expect(document.body.textContent).not.toContain("The vibe map is laid out again");
        const cancel = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!;
        await act(async () => cancel.click());

        await act(async () => {
            select.value = "vectors";
            select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await act(async () => rerunButton.click());
        expect(document.body.textContent).toContain("then the moods and the vibe map");
        expect(document.body.textContent).toContain("The vibe map is laid out again when it finishes.");
        expect(rerun).not.toHaveBeenCalled();
    });
});

describe("re-filing albums", () => {
    const openMaintenance = async () => {
        const toggle = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Maintenance Operations"))!;
        await act(async () => toggle.click());
    };
    const refileButton = () => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Re-file Albums by Tags");

    it("asks first, then starts the re-file and says where the result will appear", async () => {
        refile.mockResolvedValue({ message: "Re-filing albums by their tags" });
        await render();
        await openMaintenance();
        await act(async () => refileButton()!.click());
        expect(document.body.textContent).toContain("Albums you edited and Discover's albums stay where they are.");
        expect(refile).not.toHaveBeenCalled();

        const confirm = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Re-file Albums")!;
        await act(async () => confirm.click());
        await settle();
        expect(refile).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain("The result will show in your notifications.");
    });

    it("says so when a re-file is already running", async () => {
        refile.mockRejectedValue(new Error("Albums are already being re-filed"));
        await render();
        await openMaintenance();
        await act(async () => refileButton()!.click());
        const confirm = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Re-file Albums")!;
        await act(async () => confirm.click());
        await settle();
        expect(container.textContent).toContain("Albums are already being re-filed");
    });
});

describe("the running step's name", () => {
    const allDone = {
        ...progress,
        moods: { ...progress.moods, completed: 100, pending: 0, progress: 100 },
        similarity: { ...progress.similarity, completed: 100, pending: 0, progress: 100 },
    };

    it("is the first background step with work left, by the counts the server waits on", () => {
        expect(backgroundStepRunning(progress)).toBe("Moods running");
        expect(backgroundStepRunning({ ...progress, moods: allDone.moods })).toBe("Similarity running");
        expect(
            backgroundStepRunning({ ...progress, audioAnalysis: { ...progress.audioAnalysis, processing: 3 } }),
        ).toBe("Audio analysis running");
        expect(backgroundStepRunning({ ...allDone, audioAnalysis: { ...progress.audioAnalysis, queued: 5 } })).toBe(
            "Audio analysis running",
        );
        expect(backgroundStepRunning({ ...allDone, audioAnalysis: { ...progress.audioAnalysis, failed: 2 } })).toBe(
            "Audio analysis running",
        );
        expect(backgroundStepRunning({ ...allDone, clapEmbeddings: { ...progress.clapEmbeddings, retrying: 1 } })).toBe(
            "Vibe embeddings running",
        );
        expect(backgroundStepRunning({ ...allDone, fingerprints: { ...progress.fingerprints, pending: 4 } })).toBe(
            "Fingerprints running",
        );
    });

    it("names no finished step when every listed step is done", () => {
        expect(backgroundStepRunning(allDone)).toBe("Enrichment running");
    });

    it("uses the step list's words for every phase", () => {
        expect(phaseLabel("mood")).toBe("moods");
        expect(phaseLabel("vibe")).toBe("vibe embeddings");
        expect(phaseLabel("tracks")).toBe("song identification");
        expect(phaseLabel(null)).toBe("enrichment");
    });
});
