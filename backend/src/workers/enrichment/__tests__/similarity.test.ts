/**
 * The similarity step, tried without the scheduler: the progress read is a plain function, the feel and map
 * builders are mocks. Similarity waits until analysis and sound vectors are settled for the whole library,
 * including answers still due a retry; the map's one-time layout also waits for the artist genres.
 */

const mockGetFeatures = jest.fn();
jest.mock("../../../services/featureDetection", () => ({
    featureDetection: { getFeatures: () => mockGetFeatures() },
}));
const mockUpdateMap = jest.fn();
jest.mock("../../../services/matching/map", () => ({
    updateMap: (settled: boolean) => mockUpdateMap(settled),
}));
const mockBuildMatching = jest.fn();
jest.mock("../../../services/matching/state", () => ({
    buildMatching: () => mockBuildMatching(),
}));
jest.mock("../../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runSimilarityStep, type SimilarityInputs } from "../similarity";

const settled: SimilarityInputs = {
    audioAnalysis: { pending: 0, processing: 0, failed: 0 },
    clapEmbeddings: { pending: 0, processing: 0, retrying: 0 },
    artists: { owed: 0 },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFeatures.mockResolvedValue({ vibeEmbeddings: true });
    mockBuildMatching.mockResolvedValue({ feelUpdated: 0 });
    mockUpdateMap.mockResolvedValue({ laidOut: 0, placed: 0 });
});

describe("the map's first layout waits for the formula's inputs", () => {
    it("lays out once every input is settled", async () => {
        await runSimilarityStep(async () => settled);
        expect(mockUpdateMap).toHaveBeenCalledWith(true);
    });

    it("waits while an artist's genres are still owed", async () => {
        await runSimilarityStep(async () => ({ ...settled, artists: { owed: 2 } }));
        expect(mockUpdateMap).toHaveBeenCalledWith(false);
    });

    it.each([
        ["an analysis is waiting", { audioAnalysis: { ...settled.audioAnalysis, pending: 1 } }],
        ["an analysis is in flight", { audioAnalysis: { ...settled.audioAnalysis, processing: 1 } }],
        ["an analysis is due a retry", { audioAnalysis: { ...settled.audioAnalysis, failed: 1 } }],
        ["a sound vector is waiting", { clapEmbeddings: { ...settled.clapEmbeddings, pending: 1 } }],
        ["a sound vector is due a retry", { clapEmbeddings: { ...settled.clapEmbeddings, retrying: 1 } }],
    ])("builds nothing while %s: similarity comes after the moods", async (_what, change) => {
        expect(await runSimilarityStep(async () => ({ ...settled, ...change }))).toBe(0);
        expect(mockBuildMatching).not.toHaveBeenCalled();
        expect(mockUpdateMap).not.toHaveBeenCalled();
    });
});

describe("the step", () => {
    it("does nothing without sound vectors enabled", async () => {
        mockGetFeatures.mockResolvedValue({ vibeEmbeddings: false });
        const readProgress = jest.fn();
        expect(await runSimilarityStep(readProgress)).toBe(0);
        expect(readProgress).not.toHaveBeenCalled();
        expect(mockBuildMatching).not.toHaveBeenCalled();
    });

    it("counts the tracks that got feel, a layout or a map position", async () => {
        mockBuildMatching.mockResolvedValue({ feelUpdated: 3 });
        mockUpdateMap.mockResolvedValue({ laidOut: 10, placed: 2 });
        expect(await runSimilarityStep(async () => settled)).toBe(15);
    });

    it("builds feel before the map", async () => {
        await runSimilarityStep(async () => settled);
        expect(mockBuildMatching.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateMap.mock.invocationCallOrder[0]);
    });
});
