/**
 * The live trip's event sequence: what each player report turns into, and the
 * stopped event that ends a trip nobody reports on any more. The public user is looked up in the real database.
 */
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const P = "zz-liveListening-";
const LISTENER = { token: "t".repeat(32), username: `${P}listener` };
const mockConfig: { publicVibe: typeof LISTENER | null } = { publicVibe: LISTENER };
jest.mock("../../config", () => ({
    get config() {
        return mockConfig;
    },
}));

import { prisma } from "../../utils/db";
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

const wipe = () => prisma.user.deleteMany({ where: { id: { startsWith: P } } });
beforeAll(wipe);
afterAll(wipe);

/** The public user, as a person's account with their sharing choice (none: no settings row). */
async function seedListener(share?: boolean) {
    await prisma.user.create({
        data: {
            id: `${P}u1`,
            username: LISTENER.username,
            passwordHash: "x",
            ...(share === undefined ? {} : { settings: { create: { shareLiveListening: share } } }),
        },
    });
}

beforeEach(async () => {
    await wipe();
    jest.useFakeTimers({ now: new Date("2026-10-02T12:00:00Z") });
    resetLive();
    events = [];
    subscribeLive((e) => events.push(e));
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
});

// These look the user up in the database, which a fully faked clock would leave waiting: only the date is faked.
function fakeOnlyTheDate() {
    jest.useFakeTimers({
        now: new Date("2026-10-02T12:00:00Z"),
        doNotFake: [
            "hrtime", "nextTick", "performance", "queueMicrotask", "setImmediate", "clearImmediate",
            "setInterval", "clearInterval", "setTimeout", "clearTimeout",
        ],
    });
    resetLive();
}

describe("the public user", () => {
    beforeEach(fakeOnlyTheDate);

    it("reads the public user's sharing choice when it looks them up", async () => {
        await seedListener(false);
        await publicUserId();
        expect(getLiveState().status).toBe("hidden");
    });

    it("looks the public user up by name, and again a minute after a miss", async () => {
        expect(await publicUserId()).toBeNull();
        await seedListener();
        expect(await publicUserId()).toBeNull();
        jest.advanceTimersByTime(60_000);
        expect(await publicUserId()).toBe(`${P}u1`);
        // Once found, the answer is kept: no second lookup.
        await wipe();
        expect(await publicUserId()).toBe(`${P}u1`);
    });
});

describe("isPublicListener", () => {
    beforeEach(fakeOnlyTheDate);

    it("is the public user, and nobody else", async () => {
        await seedListener();
        expect(await isPublicListener(`${P}u1`)).toBe(true);
        expect(await isPublicListener(`${P}u2`)).toBe(false);
    });

    it("is nobody on an instance without the public vibe, whatever the database holds", async () => {
        mockConfig.publicVibe = null;
        await seedListener();
        expect(await isPublicListener(`${P}u1`)).toBe(false);
    });
});
