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
import { artistIdentityKey } from "../../services/artistIdentity";

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

describe("GET /discover/current -- the stand-in song for a suggestion with no recorded songs", () => {
    /**
     * A suggestion with an album and songs. It has no DiscoveryTrack rows unless `recorded` names the track numbers
     * to record, so /current otherwise picks one stand-in song.
     */
    async function suggestWithSongs(
        name: string,
        songs: Array<{ trackNo: number; missing?: boolean; corrupt?: boolean }>,
        status: "ACTIVE" | "LIKED" = "ACTIVE",
        recorded: number[] = [],
    ) {
        const artist = await prisma.artist.create({ data: { name: `${MARK} ${name}`, identityKey: artistIdentityKey(`${MARK} ${name}`) } });
        const album = await prisma.album.create({
            data: {
                rgMbid: `${MARK}-rg-${name}`, identityKey: `${MARK}-${name}`, title: `${MARK} ${name} LP`,
                primaryType: "Album", artistId: artist.id, location: status === "LIKED" ? "LIBRARY" : "DISCOVER",
            },
        });
        for (const s of songs) {
            await prisma.track.create({
                data: {
                    albumId: album.id, title: `${MARK} ${name} song ${s.trackNo}`, trackNo: s.trackNo, duration: 200,
                    filePath: `/music/${MARK}/${name}-${s.trackNo}.flac`, fileModified: new Date(), fileSize: 1,
                    missingSince: s.missing ? new Date() : null, corrupt: s.corrupt ?? false,
                },
            });
        }
        const kept = await prisma.track.findMany({ where: { albumId: album.id, trackNo: { in: recorded } } });
        await prisma.discoveryAlbum.create({
            data: {
                userId: listener, rgMbid: album.rgMbid, artistName: artist.name, albumTitle: album.title,
                weekStartDate: THIS_WEEK, status, downloadedAt: THIS_WEEK, similarity: 0.9, tier: "core",
                tracks: { create: kept.map((t) => ({ trackId: t.id, fileName: `${t.trackNo}.flac`, filePath: t.filePath })) },
            },
        });
        return (n: number) => `${MARK} ${name} song ${n}`;
    }

    it("takes the second song when the first one's file is missing", async () => {
        const song = await suggestWithSongs("gone", [{ trackNo: 1, missing: true }, { trackNo: 2 }]);

        const res = await request(app).get("/discover/current");

        expect(res.status).toBe(200);
        expect(titles(res.body)).toEqual([song(2)]);
        expect(res.body.tracks[0].available).toBe(true);
    });

    it("takes the second song when the first one is corrupt", async () => {
        const song = await suggestWithSongs("bad", [{ trackNo: 1, corrupt: true }, { trackNo: 2 }]);

        const res = await request(app).get("/discover/current");

        expect(titles(res.body)).toEqual([song(2)]);
    });

    it("takes the first song in track order when it is playable", async () => {
        const song = await suggestWithSongs("ok", [{ trackNo: 2 }, { trackNo: 1 }]);

        const res = await request(app).get("/discover/current");

        expect(titles(res.body)).toEqual([song(1)]);
    });

    it("shows the suggestion as pending when no song of the album is playable", async () => {
        await suggestWithSongs("none", [{ trackNo: 1, missing: true }, { trackNo: 2, corrupt: true }]);

        const res = await request(app).get("/discover/current");

        expect(res.body.tracks).toHaveLength(1);
        expect(res.body.tracks[0]).toMatchObject({ available: false, isPending: true });
    });

    it("does not list a recorded song whose file is missing, and stands in the next song of the album", async () => {
        const song = await suggestWithSongs("rec", [{ trackNo: 1, missing: true }, { trackNo: 2 }], "ACTIVE", [1]);

        const res = await request(app).get("/discover/current");

        expect(titles(res.body)).toEqual([song(2)]);
    });

    it("gives each suggestion its own song when two albums share a title", async () => {
        const first = await suggestWithSongs("twin-a", [{ trackNo: 1 }]);
        const second = await suggestWithSongs("twin-b", [{ trackNo: 1 }]);
        await prisma.album.updateMany({ where: { title: { startsWith: `${MARK} twin-` } }, data: { title: `${MARK} twin LP` } });
        await prisma.discoveryAlbum.updateMany({ where: { rgMbid: { startsWith: `${MARK}-rg-twin-` } }, data: { albumTitle: `${MARK} twin LP` } });

        const res = await request(app).get("/discover/current");

        expect(titles(res.body)).toEqual([first(1), second(1)]);
    });

    it("finds a liked suggestion's album by its release id when two albums of the artist share the title", async () => {
        const artist = await prisma.artist.create({ data: { name: `${MARK} twins`, identityKey: `${MARK}-twins` } });
        const make = async (tag: string) => {
            const album = await prisma.album.create({
                data: { rgMbid: `${MARK}-rg-${tag}`, identityKey: `${MARK}-${tag}`, title: `${MARK} same title`, primaryType: "Album", artistId: artist.id, location: "LIBRARY" },
            });
            await prisma.track.create({
                data: { albumId: album.id, title: `${MARK} song of ${tag}`, trackNo: 1, duration: 200, filePath: `/music/${MARK}/${tag}.flac`, fileModified: new Date(), fileSize: 1 },
            });
            return album;
        };
        await make("deluxe");
        const asked = await make("original");
        await prisma.discoveryAlbum.create({
            data: {
                userId: listener, rgMbid: asked.rgMbid, artistName: artist.name, albumTitle: asked.title,
                weekStartDate: THIS_WEEK, status: "LIKED", downloadedAt: THIS_WEEK, similarity: 0.9, tier: "core",
            },
        });

        const res = await request(app).get("/discover/current");

        expect(titles(res.body)).toEqual([`${MARK} song of original`]);
    });

    it("falls back to the title and artist when a suggestion carries no release id", async () => {
        const song = await suggestWithSongs("noid", [{ trackNo: 1 }]);
        await prisma.discoveryAlbum.updateMany({ where: { rgMbid: `${MARK}-rg-noid` }, data: { rgMbid: "" } });

        const res = await request(app).get("/discover/current");

        expect(titles(res.body)).toEqual([song(1)]);
    });

    describe("a suggestion with no release id is matched to its album with the artist-identity rule", () => {
        const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
        const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";

        /** A Discover album whose artist has `albumArtistMbid`, and a suggestion of it with no release id under `suggestedMbid`. */
        async function arrange(albumArtistMbid: string | null, suggestedMbid: string | null) {
            const song = await suggestWithSongs("same", [{ trackNo: 1 }]);
            await prisma.artist.updateMany({ where: { name: `${MARK} same` }, data: { mbid: albumArtistMbid } });
            await prisma.discoveryAlbum.updateMany({ where: { rgMbid: `${MARK}-rg-same` }, data: { rgMbid: "", artistMbid: suggestedMbid } });
            return song(1);
        }

        it("does not show a namesake's song on the card", async () => {
            await arrange(NAMESAKE, ARTIST);

            const res = await request(app).get("/discover/current");

            expect(res.body.tracks).toHaveLength(1);
            expect(res.body.tracks[0]).toMatchObject({ available: false, isPending: true });
        });

        it.each([
            ["the same id", ARTIST, ARTIST],
            ["no id on the suggestion", ARTIST, null],
            ["no id on the album's artist", null, ARTIST],
            ["a temp- id on the suggestion", ARTIST, "temp-1793617784650-0.5"],
        ])("shows the song with %s", async (_how, albumArtistMbid, suggestedMbid) => {
            const song = await arrange(albumArtistMbid, suggestedMbid);

            const res = await request(app).get("/discover/current");

            expect(titles(res.body)).toEqual([song]);
        });
    });

    describe("a suggestion with no release id is matched to its album by the one name rule", () => {
        const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";

        /** The album and artist as the scanner stored them, and the suggestion as Lidarr or the recommender spelt them. */
        async function arrange(stored: { artist: string; title: string }, suggested: { artist: string; title: string }, mbids: [string | null, string | null] = [null, null]) {
            const song = await suggestWithSongs("fold", [{ trackNo: 1 }]);
            await prisma.artist.updateMany({ where: { name: `${MARK} fold` }, data: { name: stored.artist, identityKey: artistIdentityKey(stored.artist), mbid: mbids[0] } });
            await prisma.album.updateMany({ where: { rgMbid: `${MARK}-rg-fold` }, data: { title: stored.title } });
            await prisma.discoveryAlbum.updateMany({
                where: { rgMbid: `${MARK}-rg-fold` },
                data: { rgMbid: "", artistName: suggested.artist, albumTitle: suggested.title, artistMbid: mbids[1] },
            });
            return song(1);
        }

        it.each([
            ["a curly apostrophe against a straight one", { artist: `${MARK} Ed O'Brien`, title: `${MARK} Don't Stop` }, { artist: `${MARK} Ed O’Brien`, title: `${MARK} Don’t Stop` }],
            ["accents against none", { artist: `${MARK} Sigur Rós`, title: `${MARK} Ágætis` }, { artist: `${MARK} Sigur Ros`, title: `${MARK} Agaetis` }],
            ["a different case", { artist: `${MARK} Low`, title: `${MARK} Double Negative` }, { artist: `${MARK} LOW`, title: `${MARK} double negative` }],
        ])("shows the song despite %s", async (_how, stored, suggested) => {
            const song = await arrange(stored, suggested);

            const res = await request(app).get("/discover/current");

            expect(titles(res.body)).toEqual([song]);
        });

        it("shows the song when the artist is spelt differently but has the same real MusicBrainz id", async () => {
            const song = await arrange(
                { artist: `${MARK} Kanye West`, title: `${MARK} Donda` },
                { artist: `${MARK} Ye`, title: `${MARK} Donda` },
                [ARTIST, ARTIST],
            );

            const res = await request(app).get("/discover/current");

            expect(titles(res.body)).toEqual([song]);
        });

        it("does not show the song of another title", async () => {
            await arrange({ artist: `${MARK} Low`, title: `${MARK} Double Negative` }, { artist: `${MARK} Low`, title: `${MARK} Hey What` });

            const res = await request(app).get("/discover/current");

            expect(res.body.tracks[0]).toMatchObject({ available: false, isPending: true });
        });
    });

    it("asks the database the same number of questions for one suggestion as for six", async () => {
        const count = async () => {
            const spies = [prisma.album, prisma.track, prisma.discoveryAlbum].flatMap((model) => [
                jest.spyOn(model, "findMany"),
                jest.spyOn(model, "findFirst"),
            ]);
            await request(app).get("/discover/current");
            const calls = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
            spies.forEach((spy) => spy.mockRestore());
            return calls;
        };
        // One suggestion of each kind, one listing a recorded song and one needing a stand-in, so every query runs.
        await suggestWithSongs("q-a", [{ trackNo: 1 }], "LIKED", [1]);
        await suggestWithSongs("q-b", [{ trackNo: 1 }], "ACTIVE");
        await suggestWithSongs("q-c", [{ trackNo: 1 }], "LIKED");
        await suggestWithSongs("q-d", [{ trackNo: 1 }], "ACTIVE", [1]);
        const few = await count();
        expect(few).toBeGreaterThan(0);
        for (const n of [1, 2, 3, 4]) {
            await suggestWithSongs(`q${n}`, [{ trackNo: 1, missing: true }, { trackNo: 2 }], n % 2 ? "LIKED" : "ACTIVE", n > 2 ? [2] : []);
        }

        expect(await count()).toBe(few);
    });

    it("never lists a library song under a Discover suggestion that records it", async () => {
        const libraryLiked = await suggestWithSongs("lib", [{ trackNo: 1 }], "LIKED");
        const own = await suggestWithSongs("own", [{ trackNo: 1 }], "ACTIVE");
        const librarySong = await prisma.track.findFirstOrThrow({ where: { title: libraryLiked(1) } });
        const ownSuggestion = await prisma.discoveryAlbum.findFirstOrThrow({ where: { rgMbid: `${MARK}-rg-own` } });
        await prisma.discoveryTrack.create({
            data: { discoveryAlbumId: ownSuggestion.id, trackId: librarySong.id, fileName: "x.flac", filePath: librarySong.filePath },
        });

        const res = await request(app).get("/discover/current");

        const own1 = res.body.tracks.filter((t: { album: string }) => t.album === `${MARK} own LP`);
        expect(own1.map((t: { title: string }) => t.title)).toEqual([own(1)]);
    });

    it("applies the same pick to a liked suggestion, whose album is in the library now", async () => {
        const song = await suggestWithSongs("liked", [{ trackNo: 1, missing: true }, { trackNo: 2 }], "LIKED");

        const res = await request(app).get("/discover/current");

        expect(titles(res.body)).toEqual([song(2)]);
    });
});
