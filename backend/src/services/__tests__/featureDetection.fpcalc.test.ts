/**
 * The feature list asks whether fpcalc runs once per process, not on every refresh: the probe starts a process and
 * blocks while it runs.
 */
const mockExecFileSync = jest.fn();
jest.mock("child_process", () => ({
    ...jest.requireActual("child_process"),
    execFileSync: (...a: unknown[]) => mockExecFileSync(...a),
}));
jest.mock("../../utils/redis", () => ({ redisClient: { get: jest.fn().mockResolvedValue(null) } }));
jest.mock("../../utils/db", () => ({
    prisma: {
        track: { findFirst: jest.fn().mockResolvedValue(null) },
        trackEmbedding: { count: jest.fn().mockResolvedValue(0) },
        systemSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    },
}));

import { featureDetection } from "../featureDetection";

it("probes fpcalc once however often the features are refreshed", async () => {
    const now = jest.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);

    expect((await featureDetection.getFeatures()).fpcalc).toBe(true);
    t += 10 * 60_000; // past the 60 s feature cache
    expect((await featureDetection.getFeatures()).fpcalc).toBe(true);

    expect(mockExecFileSync.mock.calls.filter((c) => c[0] === "fpcalc")).toHaveLength(1);
    now.mockRestore();
});
