/**
 * Two switches share one GPU runtime: vibe embeddings and audio analysis. The
 * runtime is downloaded while either is on and stays on disk, unused, when both are off; each
 * analyzer reads its own switch from the projection; each status line is
 * measured for its own switch. Real database; the data directory is a temp dir.
 */
import fs from "fs";
import os from "os";
import path from "path";

const mockPublish = jest.fn().mockResolvedValue(1);
const mockGet = jest.fn().mockResolvedValue(null);
jest.mock("../../utils/redis", () => ({
    redisClient: { publish: (...a: unknown[]) => mockPublish(...a), get: (...a: unknown[]) => mockGet(...a) },
}));
// The switch logic is host-independent; pin the platform answer so the suite
// behaves the same on an arm or macOS runner as on the linux/x86_64 target.
jest.mock("../../services/gpuPlatform", () => ({ gpuSupported: () => true }));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-toggles-"));
process.env.DATA_DIR = dataDir;

import { prisma } from "../../utils/db";

let gpu: typeof import("../gpuRuntime");
const root = path.join(dataDir, "gpu-onnx");
const projection = () => JSON.parse(fs.readFileSync(path.join(root, "enabled.json"), "utf8"));
const lastCommand = () => JSON.parse(mockPublish.mock.calls.at(-1)[1]).command;

beforeAll(async () => {
    gpu = await import("../gpuRuntime");
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", gpuOnnxEnabled: false, gpuAnalysisEnabled: false },
        update: { gpuOnnxEnabled: false, gpuAnalysisEnabled: false },
    });
});

afterAll(async () => {
    await prisma.systemSettings.update({ where: { id: "default" }, data: { gpuOnnxEnabled: false, gpuAnalysisEnabled: false } });
    await prisma.$disconnect();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("the two GPU switches", () => {
    it("wants the runtime for analysis alone, and tells only the analysis analyzer", async () => {
        await gpu.setGpuToggles({ analysis: true });
        expect(projection()).toMatchObject({ enabled: true, soundVectors: false, analysis: true });
        expect(lastCommand()).toBe("install_gpu");
    });

    it("keeps the runtime while one switch is still on", async () => {
        await gpu.setGpuToggles({ soundVectors: true });
        await gpu.setGpuToggles({ soundVectors: false });
        expect(projection()).toMatchObject({ enabled: true, soundVectors: false, analysis: true });
        expect(lastCommand()).toBe("install_gpu");
    });

    it("keeps the runtime when both are off: the files stay and the only command is to stop a running download", async () => {
        fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ status: "installed" }));
        fs.mkdirSync(path.join(root, "site", "onnxruntime"), { recursive: true });
        mockPublish.mockClear();
        await gpu.setGpuToggles({ analysis: false });
        expect(projection()).toMatchObject({ enabled: false, soundVectors: false, analysis: false });
        expect(mockPublish.mock.calls.map((c) => JSON.parse(c[1]).command)).toEqual(["cancel_gpu_install"]);
        expect(fs.existsSync(path.join(root, "site", "onnxruntime"))).toBe(true);
        expect(await gpu.getGpuStatus()).toMatchObject({ installed: true, installing: false, enabled: false, analysis: false });
    });

    it("turning a switch on again asks to install, which the analyzer answers with the files already there", async () => {
        await gpu.setGpuToggles({ soundVectors: true });
        expect(lastCommand()).toBe("install_gpu");
        expect(fs.existsSync(path.join(root, "site", "onnxruntime"))).toBe(true);
        expect(await gpu.getGpuStatus()).toMatchObject({ installed: true, enabled: true });
        await gpu.setGpuToggles({ soundVectors: false });
    });

    it("calls analysis active only when it is on, installed, and its sessions got the GPU", async () => {
        await gpu.setGpuToggles({ analysis: true });
        fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ status: "installed" }));
        expect((await gpu.getGpuStatus()).analysisEffective).toBe(false);
        fs.writeFileSync(path.join(root, "analysis-provider.json"), JSON.stringify({ active: true }));
        const status = await gpu.getGpuStatus();
        expect(status).toMatchObject({ analysis: true, analysisEffective: true, enabled: false, effective: false });
    });

    it("reports what each running process has, whatever its switch now says, so a takeover can be told from an old answer", async () => {
        await gpu.setGpuToggles({ soundVectors: false, analysis: false });
        fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ status: "installed", provider: { active: true } }));
        fs.writeFileSync(path.join(root, "analysis-provider.json"), JSON.stringify({ active: true }));
        expect(await gpu.getGpuStatus()).toMatchObject({
            effective: false, analysisEffective: false, providerActive: true, analysisProviderActive: true,
        });
        fs.writeFileSync(path.join(root, "analysis-provider.json"), JSON.stringify({ active: false, measured: false }));
        expect((await gpu.getGpuStatus()).analysisProviderActive).toBe(false);
    });

    it("says a switch fell back only when its analyzer started with the runtime and still got no GPU", async () => {
        await gpu.setGpuToggles({ soundVectors: true, analysis: true });
        const state = (provider: object) =>
            fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({ status: "installed", provider }));
        state({ active: false, measured: false });
        fs.writeFileSync(path.join(root, "analysis-provider.json"), JSON.stringify({ active: false, measured: false }));
        expect(await gpu.getGpuStatus()).toMatchObject({ fellBack: false, analysisFellBack: false });
        state({ active: false, measured: true });
        fs.writeFileSync(path.join(root, "analysis-provider.json"), JSON.stringify({ active: false, measured: true }));
        expect(await gpu.getGpuStatus()).toMatchObject({ fellBack: true, analysisFellBack: true, effective: false });
        state({ active: true, measured: true });
        expect(await gpu.getGpuStatus()).toMatchObject({ fellBack: false, effective: true });
    });

    it("calls the downloader up only while the vibe embeddings analyzer's heartbeat is fresh", async () => {
        mockGet.mockResolvedValueOnce(String(Date.now() - 10_000));
        expect((await gpu.getGpuStatus()).installerUp).toBe(true);
        // Three missed 30 s beats: down for the downloader, though the 5-minute feature check still counts it.
        mockGet.mockResolvedValueOnce(String(Date.now() - 2 * 60_000));
        expect((await gpu.getGpuStatus()).installerUp).toBe(false);
        mockGet.mockResolvedValueOnce(String(Date.now() - 10 * 60_000));
        expect((await gpu.getGpuStatus()).installerUp).toBe(false);
        mockGet.mockResolvedValueOnce(null);
        expect((await gpu.getGpuStatus()).installerUp).toBe(false);
    });
});
