import { describe, expect, it } from "vitest";
import type { GpuRuntimeStatus } from "@/lib/api";
import { gpuSettling, gpuStatusText } from "@/features/settings/components/sections/CacheSection";

const base: GpuRuntimeStatus = {
    supported: true, enabled: false, analysis: false, analysisEffective: false, installed: false, installing: false,
    effective: false, fellBack: false, analysisFellBack: false, installerUp: true, status: "idle", reason: null,
    detail: null, bytesDownloaded: null, pinned: [], providerActive: false, analysisProviderActive: false, updatedAt: null,
};

describe("the GPU status lines once both switches are off", () => {
    it("never show a failure nobody wants any more, and the page stops polling", () => {
        const g = { ...base, status: "failed", reason: "removal_failed" };
        expect(gpuStatusText(g, false, false, false)).toBe("Off (CPU)");
        expect(gpuSettling(g)).toBe(false);
    });

    it("say the kept download is there and unused", () => {
        const g = { ...base, status: "installed", installed: true };
        expect(gpuStatusText(g, false, false, false)).toBe("Runtime installed; GPU is off.");
        expect(gpuSettling(g)).toBe(false);
    });

    it("still show a failure to the switch that is on", () => {
        const g = { ...base, analysis: true, status: "failed", reason: "no_network" };
        expect(gpuStatusText(g, true, false, false)).toBe("Failed: package index unreachable");
        expect(gpuStatusText(g, false, false, false)).toBe("Off (CPU)");
    });

    it("show a download stopping after the last switch went off until it has stopped", () => {
        const g = { ...base, status: "installing", installing: true };
        expect(gpuStatusText(g, false, false, false)).toBe("Downloading GPU runtime (~2 GB)…");
        expect(gpuSettling(g)).toBe(true);
    });
});
