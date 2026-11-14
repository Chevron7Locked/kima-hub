/**
 * The identification stage's turn, through `runIdentification` and `queueIdentification` alone and no scheduler:
 * the songs owed a recording answer are looked at a hundred ahead so AcoustID's batches fill and untagged albums are
 * named, and only the first window's worth is claimed and queued.
 */

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockAdd = jest.fn();
jest.mock("../../enrichmentQueues", () => ({ trackQueue: { add: (...args: unknown[]) => mockAdd(...args) } }));

const calls: string[] = [];
const mockPrefetch = jest.fn();
const mockIdentifyAlbums = jest.fn();
jest.mock("../../../services/acoustidIdentification", () => ({
    ...jest.requireActual("../../../services/acoustidIdentification"),
    prefetchAcoustidReplies: (...args: unknown[]) => {
        calls.push("prepare");
        return mockPrefetch(...args);
    },
}));
jest.mock("../../../services/albumIdentification", () => ({
    ...jest.requireActual("../../../services/albumIdentification"),
    identifyAlbumsBySound: (...args: unknown[]) => mockIdentifyAlbums(...args),
}));

import type { StageOffer, StageWork } from "../stageOffer";
import { IDENTIFICATION_LOOKAHEAD, queueIdentification, runIdentification } from "../identification";

const work = (n: number): StageWork =>
    ({ trackId: `idrun_${n}`, title: `Song ${n}`, jobId: `job-${n}` }) as unknown as StageWork;
const owed = (count: number): StageWork[] => Array.from({ length: count }, (_, n) => work(n));

function fakeOffer(over: { owed?: StageWork[]; window?: number }) {
    const asked: number[] = [];
    const dispatched: StageWork[][] = [];
    const offer: StageOffer = {
        window: async () => over.window ?? 20,
        nextWork: async (limit) => {
            asked.push(limit);
            calls.push("nextWork");
            return (over.owed ?? []).slice(0, limit);
        },
        dispatch: async (items, produce) => {
            calls.push("dispatch");
            dispatched.push(items);
            for (const item of items) await produce(item);
            return items.length;
        },
    };
    return { offer, asked, dispatched };
}

beforeEach(() => {
    calls.length = 0;
    mockAdd.mockReset().mockResolvedValue(undefined);
    mockPrefetch.mockReset().mockResolvedValue(undefined);
    mockIdentifyAlbums.mockReset().mockResolvedValue(undefined);
});

describe("queueIdentification", () => {
    it("queues the song's job under its attempt's own job id", async () => {
        await queueIdentification(work(1));

        expect(mockAdd).toHaveBeenCalledWith(
            "enrich",
            { trackId: "idrun_1", trackTitle: "Song 1" },
            { jobId: "job-1" },
        );
    });
});

describe("runIdentification", () => {
    it("looks ahead, prepares the coming songs, then claims and queues only the window", async () => {
        const { offer, asked, dispatched } = fakeOffer({ owed: owed(150), window: 20 });

        const queued = await runIdentification(offer);

        expect(asked).toEqual([IDENTIFICATION_LOOKAHEAD]);
        expect(mockPrefetch).toHaveBeenCalledTimes(1);
        expect(calls.indexOf("prepare")).toBeGreaterThan(calls.indexOf("nextWork"));
        expect(calls.indexOf("dispatch")).toBeGreaterThan(calls.indexOf("prepare"));
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0].map((w) => w.trackId)).toEqual(owed(20).map((w) => w.trackId));
        expect(queued).toBe(20);
        expect(mockAdd).toHaveBeenCalledTimes(20);
    });

    it("queues what is owed when less than the window is owed", async () => {
        const { offer } = fakeOffer({ owed: owed(3), window: 20 });

        expect(await runIdentification(offer)).toBe(3);
        expect(mockAdd).toHaveBeenCalledTimes(3);
    });

    it("queues nothing when nothing is owed", async () => {
        const { offer } = fakeOffer({ owed: [], window: 20 });

        expect(await runIdentification(offer)).toBe(0);
        expect(mockAdd).not.toHaveBeenCalled();
    });

    it("goes on to queue the songs when the preparing step throws", async () => {
        mockPrefetch.mockRejectedValue(new Error("acoustid down"));
        const { offer } = fakeOffer({ owed: owed(2), window: 20 });

        expect(await runIdentification(offer)).toBe(2);
    });
});
