/**
 * A Subsonic queue save reads the songs, works out the index and writes, all after taking the person's playback-state
 * row, as the web save does when it sends no queue. So a library sweep retiring a song at the same moment finishes
 * first, and the save never stores a song the sweep took out; two saves meeting leave one whole save, not a mixture.
 * Real routers, real sweep and database; only Subsonic auth is injected, as the parent router would.
 */
jest.mock("../../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { reconcileDeletedTracks } from "../../../services/libraryReconcile";
import { entriesOf } from "../../../services/savedQueue";
import { untilLockWait } from "../../../__tests__/helpers/lockWait";
import { queueRouter } from "../queue";
import playbackStateRouter from "../../playbackState";
import { mountAsServer } from "../../__tests__/helpers/serverMount";

const webApp = express();
webApp.use(express.json());
mountAsServer(webApp, "/api/playback-state", playbackStateRouter, "/api/playback-state");

const P = "zz-spqc";
const USER = `${P}-user`;
const MIN = 60_000;

function app() {
    const a = express();
    a.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    });
    a.use("/", queueRouter);
    return a;
}

const song = (name: string) => `${P}-${name}`;
const save = (path: string, query: Record<string, string | string[]>) => request(app()).get(path).query({ u: USER, f: "json", ...query });
const storedIds = async () => entriesOf((await prisma.playbackState.findUniqueOrThrow({ where: { userId: USER } })).queue).map((e) => e.id);

async function cleanup() {
    await prisma.removalLog.deleteMany({ where: { filePath: { startsWith: `/tmp/${P}` } } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: `${P} Artist`, identityKey: `${P}-ar` } });
    await prisma.album.create({ data: { id: `${P}-al`, artistId: `${P}-ar`, rgMbid: `${P}-rg`, primaryType: "Album", title: `${P} Album`, location: "LIBRARY" } });
    for (const [name, missingMinutesAgo] of [["a", null], ["b", null], ["gone", 5]] as const) {
        await prisma.track.create({
            data: {
                id: song(name), albumId: `${P}-al`, title: name, trackNo: 1, duration: 100, filePath: `/tmp/${P}-${name}.flac`,
                fileModified: new Date(), fileSize: 1, missingSince: missingMinutesAgo === null ? null : new Date(Date.now() - missingMinutesAgo * MIN),
            },
        });
    }
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("a Subsonic queue save meeting the library sweep", () => {
    // The sweep rewrites the saved queues that hold the song it retires and holds their rows until it commits. A save
    // reading the song before it waits would store the retired song after it.
    it.each([
        ["savePlayQueue", "/savePlayQueue.view", { id: [song("a"), song("gone"), song("b")], current: song("b") }, 1],
        ["savePlayQueueByIndex", "/savePlayQueueByIndex.view", { id: [song("a"), song("gone"), song("b")], currentIndex: "2" }, 1],
    ])("%s waits for the sweep, then stores only the songs that remain", async (_name, path, query, expectedIndex) => {
        await prisma.playbackState.create({
            data: { userId: USER, playbackType: "track", queue: [{ id: song("a"), title: "a" }, { id: song("gone"), title: "gone" }], currentIndex: 0 },
        });

        let answer!: Promise<request.Response>;
        await prisma.$transaction(async (tx) => {
            expect((await reconcileDeletedTracks(tx, new Date(Date.now() - MIN))).removed).toBe(1);
            answer = save(path, query).then((r) => r);
            await untilLockWait(`"PlaybackState"`);
        });
        expect((await answer).status).toBe(200);

        expect(await storedIds()).toEqual([song("a"), song("b")]);
        const state = await prisma.playbackState.findUniqueOrThrow({ where: { userId: USER } });
        expect(state.currentIndex).toBe(expectedIndex);
        expect(state.trackId).toBe(song("b"));
    });

    it("stores a position past a 32-bit integer as the largest the column holds, not an error", async () => {
        const res = await save("/savePlayQueue.view", { id: [song("a")], current: song("a"), position: "99999999999" });
        expect(res.status).toBe(200);
        expect(res.body["subsonic-response"].status).toBe("ok");
        expect((await prisma.playbackState.findUniqueOrThrow({ where: { userId: USER } })).position).toBe(2_147_483_647);
    });
});

describe("a Subsonic queue save meeting a web save", () => {
    const webQueue = [song("b"), song("a")];
    const bothSave = () =>
        Promise.all([
            save("/savePlayQueue.view", { id: [song("a"), song("b")], current: song("b"), c: "Symfonium" }).then((r) => r),
            request(webApp)
                .post("/api/playback-state")
                .set("x-user", USER)
                .send({ playbackType: "track", trackId: song("a"), currentIndex: 1, queue: webQueue.map((id) => ({ id, title: id })) })
                .then((r) => r),
        ]);

    it("with no saved queue yet, both saves succeed and one of them stands", async () => {
        for (let round = 0; round < 6; round++) {
            await prisma.playbackState.deleteMany({ where: { userId: USER } });
            const [subsonic, web] = await bothSave();
            expect([subsonic.status, web.status]).toEqual([200, 200]);
            expect(subsonic.body["subsonic-response"].status).toBe("ok");
            expect(await prisma.playbackState.count({ where: { userId: USER } })).toBe(1);
        }
    });

    it("leaves one whole save: the queue, index and song of the same one", async () => {
        await prisma.playbackState.create({ data: { userId: USER, playbackType: "track", queue: [{ id: song("a"), title: "a" }], currentIndex: 0 } });
        for (let round = 0; round < 6; round++) {
            const [subsonic, web] = await bothSave();
            expect([subsonic.status, web.status]).toEqual([200, 200]);
            const state = await prisma.playbackState.findUniqueOrThrow({ where: { userId: USER } });
            const ids = entriesOf(state.queue).map((e) => e.id);
            expect([ids, state.currentIndex, state.trackId]).toEqual(
                ids[0] === song("b") ? [webQueue, 1, song("a")] : [[song("a"), song("b")], 1, song("b")],
            );
        }
    });
});
