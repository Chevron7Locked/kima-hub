/**
 * Askers for the same uncached chart share one request to Apple: rows, retries and other users joining a chart
 * already on its way never queue a second request behind Apple's shared limit. Apple's real recorded replies;
 * real Redis.
 */
import { loadRecording, startReplayServer, type ReplayServer } from "../../__tests__/helpers/replayServer";
import { waitForRedisReady } from "../../utils/redis";
import { clearCatalogCache } from "./helpers/catalogCache";
import * as catalog from "../podcastCatalog";
import { INTERACTIVE_PRIORITY, rateLimiter } from "../rateLimiter";

const recording = loadRecording("apple", "catalog");
let replay: ReplayServer;

beforeAll(async () => {
    replay = await startReplayServer(recording);
    process.env.ITUNES_BASE_URL = replay.url;
    await waitForRedisReady();
});

beforeEach(async () => {
    await clearCatalogCache();
    replay.asked.length = 0;
    replay.onRequest = null;
});

afterAll(async () => {
    delete process.env.ITUNES_BASE_URL;
    await replay.close();
});

const chartAsks1507 = () => replay.asked.filter((r) => r.includes("/rss/toppodcasts/") && r.includes("genre=1507"));
const chartAsks = () => replay.asked.filter((r) => r.includes("/rss/toppodcasts/") && r.includes("genre=1495"));

it("asks Apple once when three ask for the same chart while it is on its way", async () => {
    // Hold Apple's answer until all three have asked.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    replay.onRequest = async (request) => {
        if (request.includes("genre=1495")) await held;
    };
    const askers = [catalog.chart(1495), catalog.chart(1495)];
    await new Promise((r) => setTimeout(r, 200));
    askers.push(catalog.chart(1495));
    await new Promise((r) => setTimeout(r, 200));
    release();
    const [a, b, c] = await Promise.all(askers);
    expect(chartAsks()).toHaveLength(1);
    expect(a).toHaveLength(200);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
});

it("asks again once a request fails, rather than handing that failure to later askers", async () => {
    process.env.ITUNES_BASE_URL = "http://127.0.0.1:9"; // nothing listens: the first request fails
    await expect(catalog.chart(1495)).rejects.toThrow();
    process.env.ITUNES_BASE_URL = replay.url;
    expect(await catalog.chart(1495)).toHaveLength(200);
    expect(chartAsks()).toHaveLength(1);
});

// Jest runs the queue's tasks at once (src/__mocks__/p-queue.cjs), so these check the place each request holds in
// the queue; that the real queue runs a higher place first, and moves a waiting request when it is raised, is
// p-queue's own behaviour (priority and setPriority).
describe("what a person is waiting on goes to Apple before the category rows", () => {
    const queued: Array<{ request: string; ticket: { priority: number } | undefined }> = [];
    let spy: jest.SpyInstance;
    beforeEach(() => {
        queued.length = 0;
        const real = rateLimiter.execute.bind(rateLimiter);
        spy = jest.spyOn(rateLimiter, "execute").mockImplementation(async (service, fn, options) => {
            const before = replay.asked.length;
            const result = await real(service, fn, options);
            queued.push({ request: replay.asked[before] ?? "?", ticket: options?.ticket ?? { priority: options?.priority ?? 0 } });
            return result;
        });
    });
    afterEach(() => spy.mockRestore());
    const placesOf = (match: string) => queued.filter((q) => q.request.includes(match)).map((q) => q.ticket?.priority);

    it("queues a category row's chart behind a show page's lookup and every other chart", async () => {
        await catalog.chart(1502, "background");
        await catalog.chart(1507);
        await catalog.lookupShows(["1450241676"]);
        expect(placesOf("genre=1502")).toEqual([0]);
        expect(placesOf("genre=1507")).toEqual([INTERACTIVE_PRIORITY]);
        expect(placesOf("/lookup")).toEqual([INTERACTIVE_PRIORITY]);
    });

    it("moves a row's waiting request to the front when a person asks for the same chart, and asks Apple once", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        replay.onRequest = async () => held;
        const row = catalog.chart(1507, "background");
        await new Promise((r) => setTimeout(r, 200));
        const opened = catalog.chart(1507); // the person opens that category's page
        const again = catalog.chart(1507, "background"); // another row joins too
        release();
        const [a, b, c] = await Promise.all([row, opened, again]);
        expect(chartAsks1507()).toHaveLength(1);
        expect(placesOf("genre=1507")).toEqual([INTERACTIVE_PRIORITY]);
        expect(b).toEqual(a);
        expect(c).toEqual(a);
    });

    it("lets a category row share a request a person already started, without lowering it", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        replay.onRequest = async () => held;
        const opened = catalog.chart(1495);
        await new Promise((r) => setTimeout(r, 200));
        const row = catalog.chart(1495, "background");
        release();
        await Promise.all([opened, row]);
        expect(chartAsks()).toHaveLength(1);
        expect(placesOf("genre=1495")).toEqual([INTERACTIVE_PRIORITY]);
    });
});
