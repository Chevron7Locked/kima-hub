/**
 * The live trip's event sequence: what each player report turns into, and the
 * stopped event that ends a trip nobody reports on any more.
 */
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const LISTENER = { token: "t".repeat(32), username: "listener" };
const mockConfig: { publicVibe: typeof LISTENER | null } = { publicVibe: LISTENER };
jest.mock("../../config", () => ({
    get config() {
        return mockConfig;
    },
}));
const findUnique = jest.fn();
jest.mock("../../utils/db", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));

import {
    LiveEvent,
    getLiveState,
    isPublicListener,
    publicUserId,
    reportLive,
    resetLive,
    setLiveHidden,
    subscribeLive,
} from "../liveListening";

const A = "ctrackaaaaaaaaaaaaaaaaaa1";
const B = "ctrackbbbbbbbbbbbbbbbbbb1";

let events: LiveEvent[];

beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-10-02T12:00:00Z") });
    resetLive();
    events = [];
    subscribeLive((e) => events.push(e));
    findUnique.mockReset();
    mockConfig.publicVibe = LISTENER;
});

afterEach(() => {
    jest.useRealTimers();
});

const types = () => events.map((e) => e.type);

describe("live listening", () => {
    it("a first play starts the trip with its start time, length and queue", () => {
        reportLive({ status: "playing", trackId: A, position: 2_000, duration: 180_000, queue: [{ trackId: B, duration: 200_000 }] });
        expect(events).toEqual([
            {
                type: "started",
                at: Date.now(),
                trackId: A,
                startedAt: Date.now() - 2_000,
                duration: 180_000,
                queue: [{ trackId: B, duration: 200_000 }],
            },
        ]);
    });

    it("pause and resume carry the position", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        jest.advanceTimersByTime(10_000);
        reportLive({ status: "paused", trackId: A, position: 10_000, duration: 180_000, queue: [] });
        reportLive({ status: "playing", trackId: A, position: 10_000, duration: 180_000, queue: [] });
        expect(types()).toEqual(["started", "paused", "resumed"]);
        expect(events[1]).toMatchObject({ position: 10_000 });
    });

    it("a position away from where the clock says is a seek; one on time is not", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        jest.advanceTimersByTime(20_000);
        reportLive({ status: "playing", trackId: A, position: 20_500, duration: 180_000, queue: [] });
        reportLive({ status: "playing", trackId: A, position: 90_000, duration: 180_000, queue: [] });
        expect(types()).toEqual(["started", "seeked"]);
        expect(events[1]).toMatchObject({ position: 90_000 });
    });

    it("a new track well before the old one ends is a skip, then a start", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        jest.advanceTimersByTime(30_000);
        reportLive({ status: "playing", trackId: B, position: 0, duration: 200_000, queue: [] });
        expect(types()).toEqual(["started", "skipped", "started"]);
        expect(events[1]).toMatchObject({ trackId: B });
    });

    it("leaving a paused track for another is a skip", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        reportLive({ status: "paused", trackId: A, position: 2_000, duration: 180_000, queue: [] });
        reportLive({ status: "playing", trackId: B, position: 0, duration: 200_000, queue: [] });
        expect(types()).toEqual(["started", "paused", "skipped", "started"]);
    });

    it("a new track after a stop is not a skip", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        reportLive({ status: "stopped", trackId: A, position: 2_000, duration: 180_000, queue: [] });
        reportLive({ status: "playing", trackId: B, position: 0, duration: 200_000, queue: [] });
        expect(types()).toEqual(["started", "stopped", "started"]);
    });

    it("a new track at the old one's end is just a start", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        jest.advanceTimersByTime(179_000);
        reportLive({ status: "playing", trackId: B, position: 0, duration: 200_000, queue: [] });
        expect(types()).toEqual(["started", "started"]);
    });

    it("a changed queue on the same track is reported once", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [{ trackId: B, duration: 1 }] });
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [{ trackId: B, duration: 1 }] });
        expect(types()).toEqual(["started", "queue_changed"]);
    });

    it("a track that runs out with nothing after it stops the trip at its end", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        jest.advanceTimersByTime(180_000 + 29_000);
        expect(types()).toEqual(["started"]);
        jest.advanceTimersByTime(2_000);
        expect(types()).toEqual(["started", "stopped"]);
        expect(events[1]).toMatchObject({ trackId: A, position: 180_000 });
        expect(getLiveState()).toMatchObject({ status: "stopped", trackId: A, position: 180_000 });
    });

    it("a pause nobody returns to stops the trip after half an hour", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        reportLive({ status: "paused", trackId: A, position: 5_000, duration: 180_000, queue: [] });
        jest.advanceTimersByTime(30 * 60_000 - 1);
        expect(types()).toEqual(["started", "paused"]);
        jest.advanceTimersByTime(1);
        expect(types()).toEqual(["started", "paused", "stopped"]);
    });

    it("playing again after a stop starts a new trip", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        reportLive({ status: "stopped", trackId: A, position: 1_000, duration: 180_000, queue: [] });
        reportLive({ status: "playing", trackId: A, position: 1_000, duration: 180_000, queue: [] });
        expect(types()).toEqual(["started", "stopped", "started"]);
    });

    it("the state advances a playing track's position with the clock", () => {
        reportLive({ status: "playing", trackId: A, position: 1_000, duration: 180_000, queue: [] });
        jest.advanceTimersByTime(4_000);
        expect(getLiveState()).toMatchObject({ status: "playing", trackId: A, position: 5_000 });
    });

    it("a report with no up-next clears the previous one", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [{ trackId: B, duration: 1 }] });
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        expect(types()).toEqual(["started", "queue_changed"]);
        expect(getLiveState().queue).toEqual([]);
    });

    it("while sharing is off, the state is hidden and reports are dropped", () => {
        reportLive({ status: "playing", trackId: A, position: 0, duration: 180_000, queue: [] });
        setLiveHidden(true);
        reportLive({ status: "paused", trackId: A, position: 1_000, duration: 180_000, queue: [] });
        expect(types()).toEqual(["started", "hidden"]);
        expect(getLiveState()).toMatchObject({ status: "hidden", trackId: null, queue: [] });
        jest.advanceTimersByTime(60 * 60_000);
        expect(types()).toEqual(["started", "hidden"]);
    });

    it("turning sharing back on announces a stopped state, and the next play starts a trip", () => {
        setLiveHidden(true);
        setLiveHidden(false);
        reportLive({ status: "playing", trackId: B, position: 0, duration: 200_000, queue: [] });
        expect(types()).toEqual(["hidden", "state", "started"]);
        expect(events[1]).toMatchObject({ status: "stopped", trackId: null });
    });

    it("reads the public user's sharing choice when it looks them up", async () => {
        findUnique.mockResolvedValueOnce({ id: "u1", settings: { shareLiveListening: false } });
        await publicUserId();
        expect(getLiveState().status).toBe("hidden");
    });

    it("looks the public user up by name, and again a minute after a miss", async () => {
        findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "u1" });
        expect(await publicUserId()).toBeNull();
        expect(await publicUserId()).toBeNull();
        jest.advanceTimersByTime(60_000);
        expect(await publicUserId()).toBe("u1");
        expect(await publicUserId()).toBe("u1");
        expect(findUnique).toHaveBeenCalledTimes(2);
        expect(findUnique).toHaveBeenCalledWith({
            where: { username: "listener" },
            select: { id: true, settings: { select: { shareLiveListening: true } } },
        });
    });
});

describe("isPublicListener", () => {
    it("is the public user, and nobody else", async () => {
        findUnique.mockResolvedValue({ id: "u1" });
        expect(await isPublicListener("u1")).toBe(true);
        expect(await isPublicListener("u2")).toBe(false);
    });

    it("is nobody on an instance without the public vibe, whatever the database holds", async () => {
        mockConfig.publicVibe = null;
        findUnique.mockResolvedValue({ id: "u1" });
        expect(await isPublicListener("u1")).toBe(false);
    });
});
