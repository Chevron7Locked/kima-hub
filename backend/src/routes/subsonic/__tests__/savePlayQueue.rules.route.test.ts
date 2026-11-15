/**
 * What a Subsonic queue save accepts. The queue is cut to the operator's queue length limit, as the web save cuts it,
 * and a `current` or `currentIndex` that is sent but is no place in the list answers the generic error (code 0), not
 * the missing-parameter one (code 10): the parameter is there, it is the value that is wrong. Real routers and
 * database.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import * as systemSettings from "../../../utils/systemSettings";
import { invalidateSystemSettingsCache, QUEUE_LENGTH } from "../../../utils/systemSettings";
import { entriesOf } from "../../../services/savedQueue";
import { queueRouter } from "../queue";

const P = "zz-spqr";
const USER = `${P}-user`;
const SONGS = QUEUE_LENGTH.min + 20;
const DISCOVER_SONG = `${P}-disc`;
const MISSING_SONG = `${P}-miss`;
const CORRUPT_SONG = `${P}-corr`;

function app() {
    const a = express();
    a.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    });
    a.use("/", queueRouter);
    return a;
}

const song = (n: number) => `${P}-${String(n).padStart(4, "0")}`;
const all = Array.from({ length: SONGS }, (_, n) => song(n));
const send = (path: string, query: Record<string, string | string[]>) => request(app()).get(path).query({ u: USER, f: "json", ...query }).then((r) => r.body["subsonic-response"]);
const stored = async () => prisma.playbackState.findUnique({ where: { userId: USER } });

let savedLimit: number | undefined;

async function cleanup() {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    savedLimit = (await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { maxQueueLength: true } }))?.maxQueueLength;
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: `${P} Artist`, identityKey: `${P}-ar` } });
    await prisma.album.create({ data: { id: `${P}-al`, artistId: `${P}-ar`, rgMbid: `${P}-rg`, primaryType: "Album", title: `${P} Album`, location: "LIBRARY" } });
    await prisma.track.createMany({
        data: all.map((id, n) => ({ id, albumId: `${P}-al`, title: id, trackNo: n + 1, duration: 100, filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1 })),
    });
    // A Discover song, a library song whose file is gone and one read as corrupt.
    await prisma.album.create({ data: { id: `${P}-dal`, artistId: `${P}-ar`, rgMbid: `${P}-drg`, identityKey: `${P}-dk`, primaryType: "Album", title: `${P} Discover`, location: "DISCOVER" } });
    await prisma.track.createMany({
        data: [
            { id: DISCOVER_SONG, albumId: `${P}-dal` },
            { id: MISSING_SONG, albumId: `${P}-al`, missingSince: new Date() },
            { id: CORRUPT_SONG, albumId: `${P}-al`, corrupt: true },
        ].map((t, n) => ({ ...t, title: t.id, trackNo: 900 + n, duration: 100, filePath: `/tmp/${t.id}.flac`, fileModified: new Date(), fileSize: 1 })),
    });
});
beforeEach(async () => {
    await prisma.playbackState.deleteMany({ where: { userId: USER } });
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", maxQueueLength: QUEUE_LENGTH.min }, update: { maxQueueLength: QUEUE_LENGTH.min } });
    invalidateSystemSettingsCache();
});
afterAll(async () => {
    if (savedLimit !== undefined) await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: savedLimit } });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    await cleanup();
    await prisma.$disconnect();
});

describe("a Subsonic queue save and the operator's queue length limit", () => {
    it.each([
        ["savePlayQueue", "/savePlayQueue.view", (current: number) => ({ id: all, current: song(current) })],
        ["savePlayQueueByIndex", "/savePlayQueueByIndex.view", (current: number) => ({ id: all, currentIndex: String(current) })],
    ])("%s keeps the first songs up to the limit and drops the rest", async (_name, path, query) => {
        const reply = await send(path, { ...query(3), position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue).map((e) => e.id)).toEqual(all.slice(0, QUEUE_LENGTH.min));
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([3, song(3), 7000]);
    });

    // Digits too many for a number are still a whole number of 0 or more: the column's largest value is stored.
    it.each([
        ["savePlayQueue", "/savePlayQueue.view", { id: [song(0), song(1)], current: song(1) }],
        ["savePlayQueueByIndex", "/savePlayQueueByIndex.view", { id: [song(0), song(1)], currentIndex: "1" }],
    ])("%s takes a position of 400 digits as the largest the state holds", async (_name, path, query) => {
        const reply = await send(path, { ...query, position: "9".repeat(400) });

        expect(reply.status).toBe("ok");
        expect((await stored())!.position).toBe(2_147_483_647);
    });

    it.each([
        ["savePlayQueue", "/savePlayQueue.view", (current: number) => ({ id: all, current: song(current) })],
        ["savePlayQueueByIndex", "/savePlayQueueByIndex.view", (current: number) => ({ id: all, currentIndex: String(current) })],
    ])("%s with the current song past the limit leaves the last song kept as current, from its start", async (_name, path, query) => {
        const reply = await send(path, { ...query(SONGS - 1), position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue)).toHaveLength(QUEUE_LENGTH.min);
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([QUEUE_LENGTH.min - 1, song(QUEUE_LENGTH.min - 1), 0]);
    });

    // The position belongs to the place the player is at, not to the song: a song listed twice is two places.
    it("with the current place being a repeat of the last song kept that was cut, starts the last song kept from its start", async () => {
        const ids = [...all.slice(0, QUEUE_LENGTH.min), song(QUEUE_LENGTH.min - 1)];

        const reply = await send("/savePlayQueueByIndex.view", { id: ids, currentIndex: String(QUEUE_LENGTH.min), position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([QUEUE_LENGTH.min - 1, song(QUEUE_LENGTH.min - 1), 0]);
    });

    it("counts places, not songs: a repeat after a place that was left out keeps its own place and position", async () => {
        const reply = await send("/savePlayQueueByIndex.view", { id: [song(0), DISCOVER_SONG, song(0)], currentIndex: "2", position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue).map((e) => e.id)).toEqual([song(0), song(0)]);
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([1, song(0), 7000]);
    });

    it("counts places, not songs: a repeat the limit cuts, behind ids left out, starts the last song kept from its start", async () => {
        const ids = [`${P}-unknown`, ...all.slice(0, QUEUE_LENGTH.min), song(0)];

        const reply = await send("/savePlayQueueByIndex.view", { id: ids, currentIndex: String(QUEUE_LENGTH.min + 1), position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue)).toHaveLength(QUEUE_LENGTH.min);
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([QUEUE_LENGTH.min - 1, song(QUEUE_LENGTH.min - 1), 0]);
    });

    it("keeps the position when the current place is a repeat of a song that is kept", async () => {
        const reply = await send("/savePlayQueueByIndex.view", { id: [song(0), song(1), song(0)], currentIndex: "2", position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue).map((e) => e.id)).toEqual([song(0), song(1), song(0)]);
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([2, song(0), 7000]);
    });

    it("starts the song now in the place from its start when the current place held an unknown id, even if that song sits elsewhere in the list", async () => {
        const reply = await send("/savePlayQueueByIndex.view", { id: [song(1), `${P}-unknown`, song(1)], currentIndex: "1", position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([1, song(1), 0]);
    });

    it("counts the songs it keeps: ids Kima does not know do not use up the limit", async () => {
        const unknown = Array.from({ length: 5 }, (_, n) => `${P}-unknown-${n}`);

        await send("/savePlayQueueByIndex.view", { id: [...unknown, ...all], currentIndex: "0" });

        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual(all.slice(0, QUEUE_LENGTH.min));
    });

    it("applies a limit the operator saved at once", async () => {
        await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: QUEUE_LENGTH.min + 10 } });
        invalidateSystemSettingsCache();

        await send("/savePlayQueueByIndex.view", { id: all, currentIndex: "0" });

        expect(entriesOf((await stored())!.queue)).toHaveLength(QUEUE_LENGTH.min + 10);
    });
});

describe("a Subsonic queue save with a current song or index that is sent but is no place in the list", () => {
    const GENERIC = 0;

    it.each([
        ["savePlayQueue", { id: [song(0), song(1)], current: song(2) }, "a current song that is not in the list"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "2" }, "an index past the end"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "-1" }, "a negative index"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "abc" }, "an index that is no number"],
        ["savePlayQueueByIndex", { currentIndex: "0" }, "an index and no songs"],
    ])("%s answers code 0 for %#, and saves nothing", async (name, query, _why) => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: [{ id: song(5), title: "kept" }], currentIndex: 0 } });

        const reply = await send(`/${name}.view`, query);

        expect(reply.status).toBe("failed");
        expect(reply.error.code).toBe(GENERIC);
        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual([song(5)]);
    });

    // OpenSubsonic: `current` is optional, and so is the index of the by-index form. With songs and no current song (a
    // blank `current` or `currentIndex` is none) the queue is stored from its first song.
    it.each([
        ["savePlayQueue", "no current song", "/savePlayQueue.view", {}],
        ["savePlayQueue", "no current song and a position", "/savePlayQueue.view", { position: "7000" }],
        ["savePlayQueue", "a blank current song", "/savePlayQueue.view", { current: "" }],
        ["savePlayQueue", "a blank current song and a position", "/savePlayQueue.view", { current: "", position: "7000" }],
        ["savePlayQueueByIndex", "no index", "/savePlayQueueByIndex.view", {}],
        ["savePlayQueueByIndex", "no index and a position", "/savePlayQueueByIndex.view", { position: "7000" }],
        ["savePlayQueueByIndex", "a blank index", "/savePlayQueueByIndex.view", { currentIndex: "" }],
        ["savePlayQueueByIndex", "a blank index and a position", "/savePlayQueueByIndex.view", { currentIndex: "", position: "7000" }],
    ])("%s with songs and %s stores the queue at index 0, position 0, whatever position is sent", async (_name, _what, path, extra: Record<string, string>) => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: [{ id: song(5), title: "old" }], currentIndex: 0, position: 9000 } });

        const reply = await send(path, { id: [song(2), song(1), song(0)], ...extra });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue).map((e) => e.id)).toEqual([song(2), song(1), song(0)]);
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([0, song(2), 0]);
    });

    it.each([
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "2abc" }, "an index with trailing text"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "1.5" }, "a fractional index"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: " 1" }, "an index with a space"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "+1" }, "a signed index"],
    ])("%s answers code 0 for %#, and saves nothing", async (name, query, _why) => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: [{ id: song(5), title: "kept" }], currentIndex: 0 } });

        const reply = await send(`/${name}.view`, query);

        expect(reply.status).toBe("failed");
        expect(reply.error.code).toBe(GENERIC);
        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual([song(5)]);
    });

    it.each([
        ["savePlayQueue", "-5", "a negative position"],
        ["savePlayQueue", "abc", "a position that is no number"],
        ["savePlayQueue", "1.5", "a fractional position"],
        ["savePlayQueue", "7s", "a position with trailing text"],
        ["savePlayQueueByIndex", "-5", "a negative position"],
        ["savePlayQueueByIndex", "abc", "a position that is no number"],
        ["savePlayQueueByIndex", "1.5", "a fractional position"],
        ["savePlayQueueByIndex", "7s", "a position with trailing text"],
    ])("%s answers code 0 for %#, and saves nothing", async (name, position, _why) => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: [{ id: song(5), title: "kept" }], currentIndex: 0 } });
        const query: Record<string, string | string[]> = name === "savePlayQueue" ? { id: [song(0), song(1)], current: song(1), position } : { id: [song(0), song(1)], currentIndex: "1", position };

        const reply = await send(`/${name}.view`, query);

        expect(reply.status).toBe("failed");
        expect(reply.error.code).toBe(GENERIC);
        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual([song(5)]);
    });

    it.each([
        ["savePlayQueue", { id: [song(0), song(1)], current: song(1) }, 0, "no position"],
        ["savePlayQueue", { id: [song(0), song(1)], current: song(1), position: "" }, 0, "a blank position"],
        ["savePlayQueue", { id: [song(0), song(1)], current: song(1), position: "0" }, 0, "a position of zero"],
        ["savePlayQueue", { id: [song(0), song(1)], current: song(1), position: "4200" }, 4200, "a whole position"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "1" }, 0, "no position"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "1", position: "" }, 0, "a blank position"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "1", position: "4200" }, 4200, "a whole position"],
    ])("%s keeps a valid position: %#", async (name, query, expected, _why) => {
        expect((await send(`/${name}.view`, query)).status).toBe("ok");

        expect((await stored())!.position).toBe(expected);
    });

    it("still takes a save with no songs and nothing else, which clears the queue", async () => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: [{ id: song(5), title: "kept" }], currentIndex: 0 } });

        expect((await send("/savePlayQueue.view", {})).status).toBe("ok");
        expect((await send("/savePlayQueueByIndex.view", {})).status).toBe("ok");
        expect((await stored())!.queue).toBeNull();
    });

    // No current song, or one that names nothing (a `current` with no songs, a blank index): with no songs there is no
    // current song, and the place is 0 whatever the state held.
    it.each([
        ["savePlayQueue", { position: "5000" }],
        ["savePlayQueueByIndex", { position: "5000" }],
        ["savePlayQueue", { current: song(1), position: "5000" }],
        ["savePlayQueueByIndex", { currentIndex: "", position: "5000" }],
    ])("%s with no songs and no usable current song stores index 0, no current song and position 0", async (name, query) => {
        await prisma.playbackState.create({
            data: { userId: USER, playbackType: "track", queue: [song(5), song(6), song(7), song(8)].map((id) => ({ id, title: id })), currentIndex: 3, trackId: song(8), position: 9000 },
        });

        expect((await send(`/${name}.view`, query)).status).toBe("ok");

        const state = await stored();
        expect([state!.queue, state!.currentIndex, state!.trackId, state!.position]).toEqual([null, 0, null, 0]);
    });
});

describe("a Subsonic queue save and the songs a queue may hold", () => {
    // "Discover is only Discover": a Discover song is never stored in a queue. A library song whose file is gone, or that
    // was read as corrupt, is stored (it may come back) and hidden when the queue is read.
    it.each([
        ["savePlayQueue", "/savePlayQueue.view", (current: string) => ({ current })],
        ["savePlayQueueByIndex", "/savePlayQueueByIndex.view", (current: string) => ({ currentIndex: String([song(0), DISCOVER_SONG, MISSING_SONG, CORRUPT_SONG, song(1)].indexOf(current)) })],
    ])("%s leaves a Discover song out, and keeps a missing and a corrupt one", async (_name, path, query) => {
        const reply = await send(path, { id: [song(0), DISCOVER_SONG, MISSING_SONG, CORRUPT_SONG, song(1)], ...query(song(1)), position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue).map((e) => e.id)).toEqual([song(0), MISSING_SONG, CORRUPT_SONG, song(1)]);
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([3, song(1), 7000]);
    });

    // The app was shown the playable songs only, so what it saves back leaves out the missing and the corrupt song the
    // stored queue still holds: they stay, at their place beside the songs they sat between.
    it.each([
        ["savePlayQueue", "/savePlayQueue.view", { current: song(1) }],
        ["savePlayQueueByIndex", "/savePlayQueueByIndex.view", { currentIndex: "1" }],
    ])("%s keeps the missing and the corrupt song the stored queue holds, which the app was not shown", async (_name, path, query) => {
        const queue = [song(0), MISSING_SONG, song(1), CORRUPT_SONG, song(2)];
        await prisma.playbackState.create({
            data: { userId: USER, playbackType: "track", queue: queue.map((id) => ({ id, title: id })), currentIndex: 2, trackId: song(1), position: 7000 },
        });

        const reply = await send(path, { id: [song(0), song(1), song(2)], ...query, position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect(entriesOf(state!.queue).map((e) => e.id)).toEqual(queue);
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([2, song(1), 7000]);
    });

    it("starts the song standing in for a Discover song that was the current one, from its start", async () => {
        const reply = await send("/savePlayQueue.view", { id: [song(0), DISCOVER_SONG, song(1)], current: DISCOVER_SONG, position: "7000" });

        expect(reply.status).toBe("ok");
        const state = await stored();
        expect([state!.currentIndex, state!.trackId, state!.position]).toEqual([1, song(1), 0]);
    });
});

describe("a Subsonic queue save holds only the songs it stores", () => {
    // The library sweep holds the rows of the songs it retires until it commits; a save holding a song waits for it.
    // Here another transaction holds the rows of `lockedIds` the same way, and the save either waits or does not.
    async function finishesWhileHeld(lockedIds: string[], query: Record<string, string | string[]>): Promise<boolean> {
        let finished = false;
        let answer!: Promise<{ status: string }>;
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Track" WHERE id = ANY(${lockedIds}::text[]) ORDER BY id FOR UPDATE`;
            answer = send("/savePlayQueueByIndex.view", query);
            finished = await Promise.race([answer.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500))]);
        });
        expect((await answer).status).toBe("ok");
        return finished;
    }

    it("does not wait for a song it leaves out: a Discover song or an id Kima does not know", async () => {
        const ids = [song(0), DISCOVER_SONG, `${P}-unknown`, song(1)];

        expect(await finishesWhileHeld([DISCOVER_SONG], { id: ids, currentIndex: "0" })).toBe(true);
        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual([song(0), song(1)]);
    });

    it("does not wait for a song the limit cuts off, nor for one left out before the cut", async () => {
        const ids = [DISCOVER_SONG, ...all];

        expect(await finishesWhileHeld([song(QUEUE_LENGTH.min), song(SONGS - 1), DISCOVER_SONG], { id: ids, currentIndex: "1" })).toBe(true);
        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual(all.slice(0, QUEUE_LENGTH.min));
    });

    it("fills the places of a song the sweep deletes while the save waits for it, from the songs after the cut", async () => {
        const gone = `${P}-gone`;
        await prisma.track.create({ data: { id: gone, albumId: `${P}-al`, title: gone, trackNo: 950, duration: 100, filePath: `/tmp/${gone}.flac`, fileModified: new Date(), fileSize: 1 } });
        let answer!: Promise<{ status: string }>;
        await prisma.$transaction(async (tx) => {
            // The delete is not committed, so the save's first read still sees the song and counts it among the stored.
            await tx.track.delete({ where: { id: gone } });
            answer = send("/savePlayQueueByIndex.view", { id: [gone, ...all], currentIndex: "1" });
            await new Promise((resolve) => setTimeout(resolve, 500));
        });

        expect((await answer).status).toBe("ok");
        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual(all.slice(0, QUEUE_LENGTH.min));
    });

    it("still waits for a song it stores, even a missing one", async () => {
        expect(await finishesWhileHeld([song(1)], { id: [song(0), song(1)], currentIndex: "0" })).toBe(false);
        expect(await finishesWhileHeld([MISSING_SONG], { id: [song(0), MISSING_SONG], currentIndex: "0" })).toBe(false);
    });
});

describe("a Subsonic queue save and the queue limit read", () => {
    // A save holding a pooled connection must not wait for a second one: the limit is read before the transaction opens.
    it.each([
        ["savePlayQueue", "/savePlayQueue.view", { id: [song(0)], current: song(0) }],
        ["savePlayQueueByIndex", "/savePlayQueueByIndex.view", { id: [song(0)], currentIndex: "0" }],
    ])("%s reads the limit outside the transaction", async (_name, path, query) => {
        let inside = false;
        let opened = 0;
        const readsInside: boolean[] = [];
        const realTransaction = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
        const transaction = jest.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
            realTransaction(async (tx) => {
                inside = true;
                opened += 1;
                try {
                    return await fn(tx);
                } finally {
                    inside = false;
                }
            }, options)) as never);
        const realGet = systemSettings.getSystemSettings;
        const settings = jest.spyOn(systemSettings, "getSystemSettings").mockImplementation(async () => {
            readsInside.push(inside);
            return realGet();
        });
        try {
            expect((await send(path, query)).status).toBe("ok");
        } finally {
            transaction.mockRestore();
            settings.mockRestore();
        }

        expect(opened).toBe(1);
        expect(readsInside).toEqual([false]);
    });
});
