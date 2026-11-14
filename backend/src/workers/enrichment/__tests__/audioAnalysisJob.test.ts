/**
 * The audio analysis job, through its interface alone: what an analysis question looks like on the analyzer's list
 * and how the phase uses the scheduler's offer. No scheduler, database or Redis: the offer and the list are fakes.
 */

import { ANALYSIS_QUEUE, pushToAnalyzer, runAudioAnalysis } from "../audioAnalysisJob";
import type { StageOffer, StageWork } from "../stageOffer";

function work(n: number): StageWork {
    return {
        trackId: `t${n}`,
        stage: "analysis",
        status: "pending",
        attempt: 0,
        source: "audio",
        filePath: `/music/a/${n}.flac`,
        duration: 200 + n,
        title: `song ${n}`,
        jobKey: `track-t${n}-analysis`,
        jobId: `track-t${n}-analysis-1`,
    };
}

function fakeOffer(owed: StageWork[], windowSize: number) {
    const calls: string[] = [];
    const dispatched: StageWork[][] = [];
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
            dispatched.push(items);
            for (const item of items) await produce(item);
            return items.length;
        }),
    };
    return { offer, calls, dispatched };
}

describe("audio analysis job", () => {
    it("names the analyzer's list", () => {
        expect(ANALYSIS_QUEUE).toBe("audio:analysis:queue");
    });

    it("puts the track, file, length and claim's job id on the list, and nothing else", async () => {
        const list = { rpush: jest.fn().mockResolvedValue(1) };
        await pushToAnalyzer(list, work(1));

        expect(list.rpush).toHaveBeenCalledTimes(1);
        const [key, value] = list.rpush.mock.calls[0];
        expect(key).toBe(ANALYSIS_QUEUE);
        expect(JSON.parse(value)).toEqual({
            trackId: "t1",
            filePath: "/music/a/1.flac",
            duration: 201,
            jobId: "track-t1-analysis-1",
        });
    });

    it("reads the window first and asks for work up to it", async () => {
        const list = { rpush: jest.fn().mockResolvedValue(1) };
        const { offer, calls } = fakeOffer([work(1), work(2), work(3)], 2);

        await runAudioAnalysis(offer, list);

        expect(calls).toEqual(["window", "nextWork:2", "dispatch"]);
    });

    it("queues each offered song on the list and reports how many the dispatch queued", async () => {
        const list = { rpush: jest.fn().mockResolvedValue(1) };
        const { offer, dispatched } = fakeOffer([work(1), work(2)], 10);

        const queued = await runAudioAnalysis(offer, list);

        expect(queued).toBe(2);
        expect(dispatched[0].map((w) => w.trackId)).toEqual(["t1", "t2"]);
        expect(list.rpush).toHaveBeenCalledTimes(2);
        expect(list.rpush.mock.calls.map(([, v]) => JSON.parse(v).trackId)).toEqual(["t1", "t2"]);
    });

    it("pushes only what the dispatch hands the producer: a claim the dispatch refused is never on the list", async () => {
        const list = { rpush: jest.fn().mockResolvedValue(1) };
        const offer: StageOffer = {
            window: async () => 5,
            nextWork: async () => [work(1), work(2)],
            dispatch: async (items, produce) => {
                await produce(items[1]);
                return 1;
            },
        };

        expect(await runAudioAnalysis(offer, list)).toBe(1);
        expect(list.rpush).toHaveBeenCalledTimes(1);
        expect(JSON.parse(list.rpush.mock.calls[0][1]).trackId).toBe("t2");
    });

    it("hands the dispatch an empty offer when nothing is owed, and writes nothing", async () => {
        const list = { rpush: jest.fn() };
        const { offer, dispatched } = fakeOffer([], 4);

        expect(await runAudioAnalysis(offer, list)).toBe(0);
        expect(dispatched).toEqual([[]]);
        expect(list.rpush).not.toHaveBeenCalled();
    });

    it("lets a failed push reach the dispatch, which hands the claim back", async () => {
        const list = { rpush: jest.fn().mockRejectedValue(new Error("redis down")) };
        const { offer } = fakeOffer([work(1)], 3);

        await expect(runAudioAnalysis(offer, list)).rejects.toThrow("redis down");
    });
});
