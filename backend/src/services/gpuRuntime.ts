import fs from "fs";
import path from "path";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";
import { gpuSupported } from "./gpuPlatform";
import { featureDetection } from "./featureDetection";

// GPU toggles: sound vectors (`gpuOnnxEnabled`) and audio analysis
// (`gpuAnalysisEnabled`) share one downloaded runtime. The DB columns are the truth;
// enabled.json projects them for the analyzers, which must not read the DB at start-up.
// The CLAP analyzer owns state.json and installs the runtime while either switch is on;
// the Essentia analyzer records its provider in analysis-provider.json.

const ROOT = path.join(process.env.DATA_DIR || "/data", "gpu-onnx");
const STATE_PATH = path.join(ROOT, "state.json");
const ENABLED_PATH = path.join(ROOT, "enabled.json");
const ANALYSIS_PROVIDER_PATH = path.join(ROOT, "analysis-provider.json");
const CONTROL_CHANNEL = "audio:clap:control";

interface GpuToggles {
    soundVectors: boolean;
    analysis: boolean;
}

export { gpuSupported } from "./gpuPlatform";

interface GpuState {
    status?: string;
    reason?: string | null;
    detail?: string | null;
    bytes?: number | null;
    pinned?: string[] | null;
    provider?: { active?: boolean; measured?: boolean } | null;
    updatedAt?: string;
}

function readJsonSafe<T>(filePath: string): T | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
        return null;
    }
}

/** `enabled` (the runtime is wanted) is what the installer reads; each analyzer reads its own switch. */
function writeEnabledProjection(toggles: GpuToggles): void {
    fs.mkdirSync(ROOT, { recursive: true });
    const tmp = ENABLED_PATH + ".tmp";
    fs.writeFileSync(
        tmp,
        JSON.stringify({
            enabled: toggles.soundVectors || toggles.analysis,
            soundVectors: toggles.soundVectors,
            analysis: toggles.analysis,
            updatedAt: new Date().toISOString(),
        }),
    );
    fs.renameSync(tmp, ENABLED_PATH);
}

async function readToggles(): Promise<GpuToggles> {
    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
        select: { gpuOnnxEnabled: true, gpuAnalysisEnabled: true },
    });
    return {
        soundVectors: Boolean(settings?.gpuOnnxEnabled),
        analysis: Boolean(settings?.gpuAnalysisEnabled),
    };
}

export async function initGpuRuntimeProjection(): Promise<void> {
    try {
        writeEnabledProjection(await readToggles());
    } catch (error) {
        logger.warn(`[GPU-onnx] boot projection skipped: ${String(error)}`);
    }
}

// The vibe embeddings analyzer downloads the runtime for both switches. Its heartbeat comes every 30 s; three missed
// beats and the download is not offered.
const INSTALLER_HEARTBEAT_MS = 90_000;

function installerUp(): Promise<boolean> {
    return featureDetection.clapRunning(INSTALLER_HEARTBEAT_MS);
}

export async function getGpuStatus() {
    const toggles = await readToggles();
    const enabled = toggles.soundVectors;
    const state = readJsonSafe<GpuState>(STATE_PATH) || {};
    const installed = state.status === "installed";
    const providerActive = state.provider?.active === true;
    const analysisProvider = readJsonSafe<{ active?: boolean; measured?: boolean }>(ANALYSIS_PROVIDER_PATH);
    const analysisProviderActive = analysisProvider?.active === true;
    return {
        // The CUDA runtime only exists for linux/x86_64 CPython 3.11 (the
        // installer's own gate); on anything else the switches are not
        // offered anywhere.
        supported: gpuSupported(),
        enabled,
        analysis: toggles.analysis,
        analysisEffective: toggles.analysis && installed && analysisProviderActive,
        installed,
        installing: state.status === "installing",
        effective: enabled && installed && providerActive,
        // The analyzer started with the runtime and its session still did not get the GPU.
        fellBack: enabled && installed && state.provider?.measured === true && !providerActive,
        analysisFellBack: toggles.analysis && installed && analysisProvider?.measured === true && !analysisProviderActive,
        installerUp: await installerUp(),
        status: state.status || "idle",
        reason: state.reason ?? null,
        detail: state.detail ?? null,
        bytesDownloaded: state.bytes ?? null,
        pinned: state.pinned ?? [],
        providerActive,
        // Whether the running analysis process has the GPU, whatever its switch says (false once a process
        // started without it); providerActive is the same for sound vectors.
        analysisProviderActive,
        updatedAt: state.updatedAt ?? null,
    };
}

/**
 * Set either switch. The runtime is downloaded while either is on. Turning both off never deletes it: it
 * stays on disk, inert (each process only puts it on its path while its own switch is on), so turning a
 * switch on again needs no download. A download still running when the last switch goes off is cancelled.
 * Deleting the gpu-onnx folder in the data directory frees the space (docs/gpu.md).
 */
export async function setGpuToggles(change: Partial<GpuToggles>) {
    // Writing the switches on an unsupported platform only stores a setting
    // the analyzers will never act on; the routes refuse before this.
    if (!gpuSupported() && (change.soundVectors || change.analysis)) {
        throw new Error("GPU acceleration requires a linux/x86_64 host");
    }
    const data = {
        ...(change.soundVectors !== undefined ? { gpuOnnxEnabled: change.soundVectors } : {}),
        ...(change.analysis !== undefined ? { gpuAnalysisEnabled: change.analysis } : {}),
    };
    // upsert, not update: SystemSettings has no row until something writes one.
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", ...data },
        update: data,
    });
    invalidateSystemSettingsCache();
    const toggles = await readToggles();
    writeEnabledProjection(toggles);
    const wanted = toggles.soundVectors || toggles.analysis;
    const delivered = await redisClient.publish(
        CONTROL_CHANNEL,
        JSON.stringify({ command: wanted ? "install_gpu" : "cancel_gpu_install" }),
    );
    logger.info(
        `[GPU-onnx] sound vectors ${toggles.soundVectors ? "on" : "off"}, analysis ${toggles.analysis ? "on" : "off"} (control delivered to ${delivered} listener(s))`,
    );
    return getGpuStatus();
}

// While the GPU runtime installs, embedding offers are held so the first pass
// does not run on CPU; every other stage keeps running. The hold is bounded so
// a failed or hung download cannot freeze the pipeline. The decision is a pure
// function; `embeddingsDeferredForGpu` wraps its IO.

export const GPU_INSTALL_HOLD_MS = 10 * 60 * 1000;

export function gpuDeferDecision(params: {
    enabled: boolean;
    status: string | null | undefined;
    enabledAtMs: number | null;
    nowMs: number;
    holdMs?: number;
}): boolean {
    if (!params.enabled) return false;
    const hold = params.holdMs ?? GPU_INSTALL_HOLD_MS;
    if (params.status === "installing") {
        // Installing is only worth waiting for inside the window; a download
        // still "installing" long after the toggle is a stuck one — CPU wins.
        return params.enabledAtMs !== null && params.nowMs - params.enabledAtMs <= hold;
    }
    // Between the toggle landing and the analyzer picking it up there is a gap
    // with no install state yet. Bridge it, but only inside the window.
    if (!params.status) {
        return params.enabledAtMs !== null && params.nowMs - params.enabledAtMs <= hold;
    }
    // installed / failed / any terminal status: no hold, never.
    return false;
}

let deferCache: { atMs: number; deferred: boolean } | null = null;
const DEFER_CACHE_MS = 5_000;

export async function embeddingsDeferredForGpu(now = new Date()): Promise<boolean> {
    if (deferCache && now.getTime() - deferCache.atMs < DEFER_CACHE_MS) return deferCache.deferred;
    let deferred = false;
    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { gpuOnnxEnabled: true },
        });
        if (settings?.gpuOnnxEnabled) {
            const state = readJsonSafe<GpuState>(STATE_PATH) || {};
            const enabledAt = readJsonSafe<{ updatedAt?: string }>(ENABLED_PATH)?.updatedAt;
            deferred = gpuDeferDecision({
                enabled: true,
                status: state.status,
                enabledAtMs: enabledAt ? new Date(enabledAt).getTime() : null,
                nowMs: now.getTime(),
            });
        }
    } catch (error) {
        // A failed lookup must not stop enrichment; CPU proceeds.
        logger.warn(`[GPU-onnx] deferral check failed, not deferring: ${String(error)}`);
        deferred = false;
    }
    deferCache = { atMs: now.getTime(), deferred };
    return deferred;
}
