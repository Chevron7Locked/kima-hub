/**
 * What a Subsonic queue save accepts. The queue is cut to the operator's queue length limit, as the web save cuts it,
 * and a `current` or `currentIndex` that is sent but is no place in the list answers the generic error (code 0), not
 * the missing-parameter one (code 10): the parameter is there, it is the value that is wrong. Real routers and
 * database.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { invalidateSystemSettingsCache, QUEUE_LENGTH } from "../../../utils/systemSettings";
import { entriesOf } from "../../../services/savedQueue";
import { queueRouter } from "../queue";

const P = "zz-spqr";
const USER = `${P}-user`;
const SONGS = QUEUE_LENGTH.min + 20;

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
    const MISSING = 10;

    it.each([
        ["savePlayQueue", { id: [song(0), song(1)], current: song(2) }, "a current song that is not in the list"],
        ["savePlayQueue", { id: [song(0), song(1)], current: "" }, "a blank current song"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "2" }, "an index past the end"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "-1" }, "a negative index"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "abc" }, "an index that is no number"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)], currentIndex: "" }, "a blank index"],
        ["savePlayQueueByIndex", { currentIndex: "0" }, "an index and no songs"],
    ])("%s answers code 0 for %#, and saves nothing", async (name, query, _why) => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: [{ id: song(5), title: "kept" }], currentIndex: 0 } });

        const reply = await send(`/${name}.view`, query);

        expect(reply.status).toBe("failed");
        expect(reply.error.code).toBe(GENERIC);
        expect(entriesOf((await stored())!.queue).map((e) => e.id)).toEqual([song(5)]);
    });

    it.each([
        ["savePlayQueue", { id: [song(0), song(1)] }, "songs and no current song"],
        ["savePlayQueueByIndex", { id: [song(0), song(1)] }, "songs and no index"],
    ])("%s still answers code 10 for %#: the parameter is missing", async (name, query, _why) => {
        const reply = await send(`/${name}.view`, query);

        expect(reply.status).toBe("failed");
        expect(reply.error.code).toBe(MISSING);
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
});
