/**
 * GET /discover/current shows the latest completed batch's week, with a `stale`
 * flag when it is older than this week. GET /discover/batch-status reports the
 * latest finished batch (lastBatchId, lastBatchStatus) for a client that missed
 * the SSE. Real database and router. Weeks are worked out from today, so a
 * suggestion is told apart from the others by the song it shows. The clock is pinned mid-week.
 */

jest.mock("../../middleware/auth", () => ({
    ...jest.requireActual("../../middleware/auth"),
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import { addHours, addWeeks, endOfWeek, startOfWeek } from "date-fns";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";
import { WEEK_STARTS_ON } from "../../lib/discoveryWeek";
import { useMidWeekClock } from "./helpers/midWeekClock";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-curfall";
let listener: string;
let other: string;
let acting: string;

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: acting, username: `${MARK}-listener`, role: "user" };
    next();
});
mountAsServer(app, "/discover", discoverRoutes, "/api/discover");

useMidWeekClock();

// "Today" is in the calendar week starting THIS_WEEK.
const THIS_WEEK = startOfWeek(new Date(), { weekStartsOn: WEEK_STARTS_ON });
const LAST_WEEK = addWeeks(THIS_WEEK, -1);
const NEXT_WEEK = addWeeks(THIS_WEEK, 1);

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    // The router pulls in services/listenBrainz, which opens the shared Redis
    // client at import. Left open, Jest finishes the suite and outlives the
    // process on that socket.
    await closeClient(redisClient);
});

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(cleanup);
beforeEach(async () => {
    await cleanup();
    listener = (await prisma.user.create({ data: { username: `${MARK}-listener`, passwordHash: "x" } })).id;
    other = (await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: "x" } })).id;
    acting = listener;
});

/** A batch of the listener's, with the week it is keyed by. */
const batch = (weekStart: Date, status: string, extra: { createdAt?: Date; completedAt?: Date; userId?: string } = {}) =>
    prisma.discoveryBatch.create({
        data: { userId: listener, weekStart, targetSongCount: 5, status, ...extra },
    });

/** A suggestion of that week with a Discover song, as the downloaded album leaves it. Returns the song's title. */
async function suggest(weekStartDate: Date, name: string): Promise<string> {
    const artist = await prisma.artist.create({ data: { name: `${MARK} ${name}`, identityKey: `${MARK}-${name}` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg-${name}`, identityKey: `${MARK}-${name}`, title: `${MARK} ${name} LP`, primaryType: "Album", artistId: artist.id, location: "DISCOVER" },
    });
    const track = await prisma.track.create({
        data: { albumId: album.id, title: `${MARK} ${name} song`, trackNo: 1, duration: 320, filePath: `/music/${MARK}/${name}.flac`, fileModified: new Date(), fileSize: 1 },
    });
    await prisma.discoveryAlbum.create({
        data: {
            userId: listener,
            rgMbid: album.rgMbid,
            artistName: artist.name,
            albumTitle: album.title,
            weekStartDate,
            status: "ACTIVE",
            downloadedAt: weekStartDate,
            similarity: 0.9,
            tier: "core",
            tracks: { create: { trackId: track.id, fileName: "song.flac", filePath: track.filePath } },
        },
    });
    return track.title;
}

const unavailable = (weekStartDate: Date, albumMbid: string) =>
    prisma.unavailableAlbum.create({
        data: { userId: listener, albumMbid, artistName: `${MARK} Missing Band`, albumTitle: `${MARK} ${albumMbid}`, similarity: 0.5, tier: "medium", weekStartDate },
    });

const titles = (body: { tracks: Array<{ title: string }> }) => body.tracks.map((t) => t.title).sort();
const instant = (iso: string) => new Date(iso).getTime();

describe("GET /discover/current -- shows the latest completed batch", () => {
    it("shows the albums of the older batch week, not the empty calendar week", async () => {
        // The latest completed batch and its albums are last week's; this week has a suggestion too, which is not shown.
        await batch(LAST_WEEK, "completed", { completedAt: new Date() });
        const lastWeeks = await suggest(LAST_WEEK, "last");
        await suggest(THIS_WEEK, "this");

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(titles(res.body)).toEqual([lastWeeks]);
        expect(instant(res.body.weekStart)).toBe(LAST_WEEK.getTime());
        expect(instant(res.body.weekStart)).not.toBe(THIS_WEEK.getTime());
    });

    it("serves an older completed batch with stale set", async () => {
        await batch(LAST_WEEK, "completed", { completedAt: new Date() });
        await suggest(LAST_WEEK, "last");

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(true);
    });

    it("falls back to the calendar week, not stale, when no batch has completed", async () => {
        const thisWeeks = await suggest(THIS_WEEK, "this");
        await suggest(LAST_WEEK, "last");

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(titles(res.body)).toEqual([thisWeeks]);
        expect(instant(res.body.weekStart)).toBe(THIS_WEEK.getTime());
        expect(res.body.stale).toBe(false);
    });

    it("looks only at completed batches", async () => {
        // An in-flight or failed batch must not decide the week /current shows.
        await batch(LAST_WEEK, "scanning");
        await batch(LAST_WEEK, "failed", { completedAt: new Date() });
        await suggest(LAST_WEEK, "last");
        const thisWeeks = await suggest(THIS_WEEK, "this");

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(titles(res.body)).toEqual([thisWeeks]);
        expect(res.body.stale).toBe(false);
    });

    it("looks only at the listener's own batches", async () => {
        await batch(LAST_WEEK, "completed", { completedAt: new Date(), userId: other });

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(instant(res.body.weekStart)).toBe(THIS_WEEK.getTime());
        expect(res.body.stale).toBe(false);
    });

    it("takes the newest completed batch", async () => {
        await batch(addWeeks(THIS_WEEK, -2), "completed", { completedAt: new Date(), createdAt: addWeeks(new Date(), -2) });
        await batch(LAST_WEEK, "completed", { completedAt: new Date(), createdAt: addWeeks(new Date(), -1) });
        await suggest(addWeeks(THIS_WEEK, -2), "older");
        const newer = await suggest(LAST_WEEK, "newer");

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(titles(res.body)).toEqual([newer]);
    });

    it("ends the week and scopes the unavailable albums to the resolved week, not the calendar week", async () => {
        await batch(LAST_WEEK, "completed", { completedAt: new Date() });
        await suggest(LAST_WEEK, "last");
        await unavailable(LAST_WEEK, `${MARK}-rg-last-week`);
        await unavailable(THIS_WEEK, `${MARK}-rg-this-week`);

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        // The Sunday of the resolved week, not the calendar week's.
        expect(instant(res.body.weekEnd)).toBe(endOfWeek(LAST_WEEK, { weekStartsOn: WEEK_STARTS_ON }).getTime());
        expect(res.body.unavailable.map((a: { albumId: string }) => a.albumId)).toEqual([`${MARK}-rg-last-week`]);
    });

    it("serves a batch generated early for the upcoming week as not stale", async () => {
        await batch(NEXT_WEEK, "completed", { completedAt: new Date() });
        const upcoming = await suggest(NEXT_WEEK, "next");
        await suggest(THIS_WEEK, "this");

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(false);
        expect(instant(res.body.weekStart)).toBe(NEXT_WEEK.getTime());
        expect(titles(res.body)).toEqual([upcoming]);
    });

    // The batch's stored week start is midnight Monday in Tokyo, 9 hours before the same midnight in UTC. It is
    // still this week's batch, and its albums are found by the instant they were stored under.
    it("counts a batch made at another time zone's midnight as its own week, keyed by its stored instant", async () => {
        const tokyoMonday = addHours(THIS_WEEK, -9);
        await batch(tokyoMonday, "completed", { completedAt: new Date() });
        const stored = await suggest(tokyoMonday, "tokyo");
        await suggest(THIS_WEEK, "this");
        await unavailable(tokyoMonday, `${MARK}-rg-gone-tokyo`);

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(false);
        expect(instant(res.body.weekStart)).toBe(THIS_WEEK.getTime());
        expect(instant(res.body.weekEnd)).toBe(endOfWeek(THIS_WEEK, { weekStartsOn: WEEK_STARTS_ON }).getTime());
        expect(titles(res.body)).toEqual([stored]);
        expect(res.body.unavailable.map((a: { albumId: string }) => a.albumId)).toEqual([`${MARK}-rg-gone-tokyo`]);
    });

    it("serves a batch that matches the calendar week as not stale", async () => {
        await batch(THIS_WEEK, "completed", { completedAt: new Date() });
        const thisWeeks = await suggest(THIS_WEEK, "this");

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(res.body.stale).toBe(false);
        expect(instant(res.body.weekStart)).toBe(THIS_WEEK.getTime());
        expect(titles(res.body)).toEqual([thisWeeks]);
    });
});

describe("GET /discover/batch-status -- reports the latest finished batch when none is active", () => {
    it("returns lastBatchId and lastBatchStatus from a finished batch", async () => {
        const done = await batch(LAST_WEEK, "completed", { completedAt: new Date() });

        const res = await request(app).get("/discover/batch-status");

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        expect(res.body.lastBatchId).toBe(done.id);
        expect(res.body.lastBatchStatus).toBe("completed");
    });

    it("returns null, not a missing field, for lastBatchId and lastBatchStatus when nothing has finished", async () => {
        // Another listener's finished batch is not this listener's.
        await batch(LAST_WEEK, "completed", { completedAt: new Date(), userId: other });

        const res = await request(app).get("/discover/batch-status");

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(false);
        // A client tells "nothing finished yet" from "field absent" by null versus missing.
        expect(res.body).toHaveProperty("lastBatchId", null);
        expect(res.body).toHaveProperty("lastBatchStatus", null);
    });

    it("takes the listener's most recently completed batch, finished or failed", async () => {
        const hoursAgo = (h: number) => addHours(new Date(), -h);
        await batch(LAST_WEEK, "completed", { completedAt: hoursAgo(5) });
        const latest = await batch(LAST_WEEK, "failed", { completedAt: hoursAgo(2) });
        // Finished more recently still, but another listener's.
        await batch(LAST_WEEK, "completed", { completedAt: hoursAgo(1), userId: other });

        const res = await request(app).get("/discover/batch-status");

        expect(res.status).toBe(200);
        expect(res.body.lastBatchId).toBe(latest.id);
        expect(res.body.lastBatchStatus).toBe("failed");
    });

    it("counts only in-flight batches as active", async () => {
        await batch(LAST_WEEK, "completed", { completedAt: new Date() });
        await batch(LAST_WEEK, "failed", { completedAt: new Date() });
        expect((await request(app).get("/discover/batch-status")).body.active).toBe(false);

        const scanning = await batch(THIS_WEEK, "scanning");
        const res = await request(app).get("/discover/batch-status");

        expect(res.body).toMatchObject({ active: true, status: "scanning", batchId: scanning.id });
    });

    it("reports progress, and no finished batch, when a batch is active", async () => {
        await batch(LAST_WEEK, "completed", { completedAt: new Date() });
        const active = await batch(THIS_WEEK, "scanning");
        for (const status of ["completed", "completed", "pending", "failed"]) {
            await prisma.downloadJob.create({
                data: { userId: listener, subject: `${MARK} ${status}`, type: "album", status, discoveryBatchId: active.id },
            });
        }

        const res = await request(app).get("/discover/batch-status");

        expect(res.status).toBe(200);
        expect(res.body.active).toBe(true);
        expect(res.body.batchId).toBe(active.id);
        // 2 completed + 1 failed of 4 -> 75%.
        expect(res.body.progress).toBe(75);
        expect(res.body).toMatchObject({ completed: 2, failed: 1, total: 4 });
        expect(res.body).not.toHaveProperty("lastBatchId");
    });
});
