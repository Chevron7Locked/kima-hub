/**
 * The GPU switches are read through the settings module, never from the table directly: the boot projection and the
 * embedding deferral both follow what that module answers. The switches are plain fields another process may have just
 * flipped, so they are read past the cache.
 */
import fs from "fs";
import os from "os";
import path from "path";

const mockFresh = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    readSystemSettingsFresh: (...fields: string[]) => mockFresh(...fields),
    saveSystemSettings: jest.fn(),
}));
jest.mock("../../utils/redis", () => ({ redisClient: { publish: jest.fn(), get: jest.fn() } }));
jest.mock("../../services/gpuPlatform", () => ({ gpuSupported: () => true }));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-settings-read-"));
process.env.DATA_DIR = dataDir;
const root = path.join(dataDir, "gpu-onnx");

let gpu: typeof import("../gpuRuntime");

beforeAll(async () => {
    const { prisma } = await import("../../utils/db");
    jest.spyOn(prisma.systemSettings, "findUnique").mockImplementation(() => {
        throw new Error("the settings table was read directly");
    });
    gpu = await import("../gpuRuntime");
});

afterAll(async () => {
    jest.restoreAllMocks();
    const { prisma } = await import("../../utils/db");
    await prisma.$disconnect();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
    mockFresh.mockReset();
});

describe("the boot projection", () => {
    it("writes the switches the settings module answers", async () => {
        mockFresh.mockResolvedValue({ gpuOnnxEnabled: true, gpuAnalysisEnabled: false });

        await gpu.initGpuRuntimeProjection();

        expect(mockFresh).toHaveBeenCalledWith("gpuOnnxEnabled", "gpuAnalysisEnabled");
        expect(JSON.parse(fs.readFileSync(path.join(root, "enabled.json"), "utf8"))).toMatchObject({
            enabled: true,
            soundVectors: true,
            analysis: false,
        });
    });
});

describe("embeddingsDeferredForGpu", () => {
    it("holds while the switch the settings module answers is on and the runtime is installing", async () => {
        mockFresh.mockResolvedValue({ gpuOnnxEnabled: true });
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, "enabled.json"), JSON.stringify({ updatedAt: new Date().toISOString() }));

        expect(await gpu.embeddingsDeferredForGpu(new Date())).toBe(true);
        expect(mockFresh).toHaveBeenCalledWith("gpuOnnxEnabled");
    });
});
