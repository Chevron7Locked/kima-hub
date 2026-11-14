/**
 * The sound vector job, through its interface alone: whether it runs, what a vector question looks like on the vibe
 * queue and how the phase uses the scheduler's offer. No scheduler or database: the offer is a fake and the vibe queue
 * and feature check are mocked at their own modules.
 */

const mockAdd = jest.fn().mockResolvedValue(undefined);
const mockGetFeatures = jest.fn();

jest.mock("../../enrichmentQueues", () => ({ vibeQueue: { add: (...args: unknown[]) => mockAdd(...args) } }));
jest.mock("../../../services/featureDetection", () => ({
    featureDetection: { getFeatures: (...args: unknown[]) => mockGetFeatures(...args) },
}));

import { queueSoundVector, runSoundVectors } from "../soundVectorJob";
import type { StageOffer, StageWork } from "../stageOffer";

function work(n: number): StageWork {
    return {
        trackId: `t${n}`,
        stage: "embedding",
        status: "pending",
        attempt: 1,
        source: "clap",
        filePath: `/music/a/${n}.flac`,
        duration: 180 + n,
        title: `song ${n}`,
        jobKey: `track-t${n}-embedding`,
        jobId: `track-t${n}-embedding-2`,
    };
}

function fakeOffer(owed: StageWork[], windowSize: number) {
    const calls: string[] = [];
    const offer: StageOffer = {
        window: jest.fn(async () => {
            calls.push("window");
            return windowSize;
        }),
        nextWork: jest.fn(async (limit: number) => {
            calls.push(`nextWork:${limit}`);
            return owed.slice(0, limit);
        }),
        dispatch: jest.fn(async (items, produce) => {
            calls.push("dispatch");
            for (const item of items) await produce(item);
            return items.length;
        }),
    };
    return { offer, calls };
}

describe("sound vector job", () => {
    beforeEach(() => {
        mockGetFeatures.mockResolvedValue({ vibeEmbeddings: true });
    });

    it("queues an embed job with the track, file and length, keyed by this attempt's job id", async () => {
        await queueSoundVector(work(1));

        expect(mockAdd).toHaveBeenCalledTimes(1);
        expect(mockAdd).toHaveBeenCalledWith(
            "embed",
            { trackId: "t1", filePath: "/music/a/1.flac", duration: 181 },
            { jobId: "track-t1-embedding-2" },
        );
    });

    it("reads the window first, asks for work up to it and queues what the dispatch hands over", async () => {
        const { offer, calls } = fakeOffer([work(1), work(2), work(3)], 2);

        const queued = await runSoundVectors(offer);

        expect(calls).toEqual(["window", "nextWork:2", "dispatch"]);
        expect(queued).toBe(2);
        expect(mockAdd.mock.calls.map(([, data]) => data.trackId)).toEqual(["t1", "t2"]);
    });

    it("does nothing, and asks the scheduler for nothing, when this install has no vector embeddings", async () => {
        mockGetFeatures.mockResolvedValue({ vibeEmbeddings: false });
        const { offer } = fakeOffer([work(1)], 5);

        expect(await runSoundVectors(offer)).toBe(0);
        expect(offer.window).not.toHaveBeenCalled();
        expect(offer.nextWork).not.toHaveBeenCalled();
        expect(offer.dispatch).not.toHaveBeenCalled();
        expect(mockAdd).not.toHaveBeenCalled();
    });

    it("lets a failed queue add reach the dispatch, which hands the claim back", async () => {
        mockAdd.mockRejectedValueOnce(new Error("queue closed"));
        const { offer } = fakeOffer([work(1)], 3);

        await expect(runSoundVectors(offer)).rejects.toThrow("queue closed");
    });
});
