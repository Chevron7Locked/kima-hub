/**
 * POST /api/playback-state: a save the database refuses answers 500 with a
 * generic body, never the driver's message. Real database. The refusal comes
 * from a user id with no row, which breaks the playback state's foreign key.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import * as systemSettings from "../../utils/systemSettings";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { reconcileDeletedTracks } from "../../services/libraryReconcile";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import playbackStateRouter from "../playbackState";
import { mountAsServer } from "./helpers/serverMount";
import { untilLockWait } from "../../__tests__/helpers/lockWait";

const PREFIX = "playback-state-save-test";

const app = express();
app.use(express.json());
mountAsServer(app, "/api/playback-state", playbackStateRouter, "/api/playback-state");

const S = "pbsave";

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: S } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: S } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: S } } });
}

/** Library songs (and one whose file is gone), so a saved queue points at songs the server really knows. */
async function seedSongs() {
    await prisma.artist.create({ data: { id: `${S}art`, name: "Save Artist", identityKey: `${S}-a` } });
    await prisma.album.create({ data: { id: `${S}alb`, artistId: `${S}art`, rgMbid: `${S}-rg`, identityKey: `${S}-ak`, title: "Save Album", primaryType: "Album" } });
    // `bad` is read as corrupt, and `d1` is on a Discover album.
    await prisma.album.create({ data: { id: `${S}dalb`, artistId: `${S}art`, rgMbid: `${S}-drg`, identityKey: `${S}-dk`, title: "Discover Album", primaryType: "Album", location: "DISCOVER" } });
    for (const [id, missing, corrupt, albumId] of [
        ["s1", false, false, `${S}alb`], ["s2", false, false, `${S}alb`], ["s3", false, false, `${S}alb`], ["s4", false, false, `${S}alb`],
        ["gone", true, false, `${S}alb`], ["bad", false, true, `${S}alb`], ["d1", false, false, `${S}dalb`],
    ] as const) {
        await prisma.track.create({
            data: {
                id: `${S}${id}`, albumId, title: id, trackNo: 1, duration: 100, filePath: `/tmp/${S}${id}.flac`,
                fileModified: new Date(), fileSize: 1, missingSince: missing ? new Date() : null, corrupt,
            },
        });
    }
}

beforeAll(async () => {
    await cleanup();
    await seedSongs();
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});
beforeEach(() => jest.clearAllMocks());

describe("POST /api/playback-state", () => {
    it("saves the state for a real user", async () => {
        const user = await prisma.user.create({
            data: { username: `${PREFIX}-ok`, passwordHash: "x", role: "user" },
        });

        const res = await request(app)
            .post("/api/playback-state")
            .set("x-user", user.id)
            .send({ playbackType: "track" });

        expect(res.status).toBe(200);
        const saved = await prisma.playbackState.findUnique({ where: { userId: user.id } });
        expect(saved?.playbackType).toBe("track");
    });

    // Two devices of one person saving for the first time at once: the second is an update of the first's row, not a failure.
    it.each([
        ["with a queue each", { queue: [{ id: `${S}s1`, title: "s1" }] }, { queue: [{ id: `${S}s2`, title: "s2" }] }],
        ["with a queue and a position only", { queue: [{ id: `${S}s1`, title: "s1" }] }, { currentIndex: 0, trackId: `${S}s1` }],
        ["with no queue either", { isShuffle: true }, { currentIndex: 3 }],
    ])("answers 200 to both of two first saves sent together, %s", async (_name, first, second) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-race-${_name.replace(/\W+/g, "")}`, passwordHash: "x", role: "user" } });
        const send = (body: object) => request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", ...body }).then((r) => r);

        const answers = await Promise.all([send(first), send(second)]);

        expect(answers.map((a) => a.status)).toEqual([200, 200]);
        expect(await prisma.playbackState.count({ where: { userId: user.id } })).toBe(1);
    });

    // The same, with the other device's first save held uncommitted so the two certainly meet: the save that finds the
    // row taken once it commits updates it.
    it.each([
        ["sends a queue", { queue: [{ id: `${S}s2`, title: "s2" }] }],
        ["moves the index only", { currentIndex: 3 }],
    ])("answers 200 to a first save that meets another device's first save still in flight, when it %s", async (_name, body) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-meet-${_name.replace(/\W+/g, "")}`, passwordHash: "x", role: "user" } });

        let answer!: Promise<request.Response>;
        await prisma.$transaction(async (tx) => {
            await tx.playbackState.create({ data: { userId: user.id, playbackType: "track", isShuffle: true } });
            answer = request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", ...body }).then((r) => r);
            await untilLockWait(`"PlaybackState"`);
        });

        const res = await answer;
        expect(res.status).toBe(200);
        const saved = await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } });
        expect(saved.isShuffle).toBe(true);
        expect(saved.playbackType).toBe("track");
    });

    it("keeps a queued song's edited title, so another device shows the edit too", async () => {
        const user = await prisma.user.create({
            data: { username: `${PREFIX}-title`, passwordHash: "x", role: "user" },
        });
        await prisma.track.update({ where: { id: `${S}s1` }, data: { displayTitle: "edited title" } });
        try {
            // The client sends the entries it holds, which may be older than Kima's record of the songs.
            const queue = [
                { id: `${S}s1`, title: "file title", displayTitle: "stale edit", duration: 200 },
                { id: `${S}s2`, title: "no edit", duration: 100 },
            ];

            await request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", queue }).expect(200);

            const saved = await prisma.playbackState.findUnique({ where: { userId: user.id } });
            expect((saved?.queue as Array<{ title: string; displayTitle: string | null }>).map((q) => [q.title, q.displayTitle])).toEqual([
                ["s1", "edited title"],
                ["s2", null],
            ]);
        } finally {
            await prisma.track.update({ where: { id: `${S}s1` }, data: { displayTitle: null } });
        }
    });

    // A Subsonic app reads who changed the queue last. A save from the web is Kima's, and takes the place of the name
    // an app saved before it, whether it sends a queue or only moves the index.
    it.each([
        ["a first save", null, { queue: [{ id: `${S}s1`, title: "s1" }] }],
        ["a save that replaces the queue", "Symfonium", { queue: [{ id: `${S}s1`, title: "s1" }] }],
        ["a save that moves the index only", "Symfonium", { currentIndex: 0 }],
        ["a save that toggles shuffle", "Symfonium", { isShuffle: true }],
    ])("records Kima as the one who changed it: %s", async (name, before, body) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-by-${name.replace(/\W+/g, "")}`, passwordHash: "x", role: "user" } });
        if (before) {
            await prisma.playbackState.create({
                data: { userId: user.id, playbackType: "track", queue: [{ id: `${S}s1`, title: "s1" }], currentIndex: 0, changedBy: before },
            });
        }

        await request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", ...body }).expect(200);

        expect((await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } })).changedBy).toBe("Kima");
    });

    it("answers 500 with only the generic message when the database refuses the save", async () => {
        const logged = expectLog("error");
        const res = await request(app)
            .post("/api/playback-state")
            .set("x-user", "cplaybackstatenosuchuser0001")
            .send({ playbackType: "track" });

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Failed to save playback state" });
        expect(logged).toHaveBeenCalledWith(
            "Save playback state error:",
            expect.any(Error),
        );
    });
});

describe("POST /api/playback-state: where the queue came from", () => {
    // Real songs: the answer shows only the playable ones, as a read does.
    const queue = [{ id: `${S}s1`, title: "one", duration: 100 }, { id: `${S}s2`, title: "two", duration: 100 }];
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const storedSource = async (userId: string) =>
        ((await prisma.playbackState.findUnique({ where: { userId } })) as { queueSource?: string | null } | null)?.queueSource;

    it("keeps the source saved with a queue, and answers it", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src`, passwordHash: "x", role: "user" } });
        const res = await save(user.id, { playbackType: "track", queue, queueSource: "album:a-1" }).expect(200);
        expect(res.body.queueSource).toBe("album:a-1");
        expect(await storedSource(user.id)).toBe("album:a-1");
    });

    it("clears the source when a queue is saved without one, as an older client or the iOS app does", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src-clear`, passwordHash: "x", role: "user" } });
        await save(user.id, { playbackType: "track", queue, queueSource: "playlist:p-1" }).expect(200);
        await save(user.id, { playbackType: "track", queue }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
    });

    it("leaves the source alone on a save that sends no queue", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src-partial`, passwordHash: "x", role: "user" } });
        await save(user.id, { playbackType: "track", queue, queueSource: "mix:m-1" }).expect(200);
        await save(user.id, { playbackType: "track", isShuffle: true, currentIndex: 1 }).expect(200);
        expect(await storedSource(user.id)).toBe("mix:m-1");
    });

    it("drops a source that is not a short string, and one saved with an empty queue", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-src-bad`, passwordHash: "x", role: "user" } });
        await save(user.id, { playbackType: "track", queue, queueSource: { x: 1 } }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
        await save(user.id, { playbackType: "track", queue, queueSource: "x".repeat(500) }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
        await save(user.id, { playbackType: "track", queue: [], queueSource: "album:a-1" }).expect(200);
        expect(await storedSource(user.id)).toBeNull();
    });
});

describe("POST /api/playback-state: where the player is in the queue", () => {
    const song = (n: string) => ({ id: `${S}${n}`, title: n, duration: 100 });
    const queue = [song("s1"), song("s2"), song("s3")];
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const storedIndex = async (userId: string) => (await prisma.playbackState.findUnique({ where: { userId } }))?.currentIndex;
    const storedIds = async (userId: string) =>
        ((await prisma.playbackState.findUnique({ where: { userId } }))?.queue as Array<{ id: string }> | null)?.map((e) => e.id);
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
    // The stored queue holds a song whose file is gone, which a client is never shown: its index counts what it was shown.
    const withGone = [song("s1"), song("gone"), song("s2"), song("s3")];

    it("counts the index by the song named, not by the queue's shape, when a save sends no queue", async () => {
        const user = await newUser("idx-id");
        await save(user.id, { playbackType: "track", queue: withGone }).expect(200);
        // The client was shown s1, s2, s3 and is on s3: its index is 2, the stored queue's is 3.
        await save(user.id, { playbackType: "track", trackId: `${S}s3`, currentIndex: 2 }).expect(200);
        expect(await storedIndex(user.id)).toBe(3);
    });

    it("takes the named song's place whichever way the client counted", async () => {
        const user = await newUser("idx-either");
        await save(user.id, { playbackType: "track", queue: withGone }).expect(200);
        // Counted over the stored queue (an app that keeps it whole).
        await save(user.id, { playbackType: "track", trackId: `${S}s3`, currentIndex: 3 }).expect(200);
        expect(await storedIndex(user.id)).toBe(3);
        // Counted by neither: the song named wins.
        await save(user.id, { playbackType: "track", trackId: `${S}s2`, currentIndex: 0 }).expect(200);
        expect(await storedIndex(user.id)).toBe(2);
    });

    it("with a song that sits twice in the queue, keeps the one nearest where the client says it is", async () => {
        const user = await newUser("idx-twice");
        await save(user.id, { playbackType: "track", queue: [song("s1"), song("s2"), song("s1"), song("s3")] }).expect(200);
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, currentIndex: 2 }).expect(200);
        expect(await storedIndex(user.id)).toBe(2);
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, currentIndex: 0 }).expect(200);
        expect(await storedIndex(user.id)).toBe(0);
    });

    it("maps a shown index through the stored queue when the save names no song, or one that is not in it", async () => {
        const user = await newUser("idx-map");
        await save(user.id, { playbackType: "track", queue: withGone }).expect(200);
        await save(user.id, { playbackType: "track", currentIndex: 2 }).expect(200);
        expect(await storedIndex(user.id)).toBe(3);
        await save(user.id, { playbackType: "track", trackId: `${S}s4`, currentIndex: 1 }).expect(200);
        expect(await storedIndex(user.id)).toBe(2);
    });

    describe("a save that names the current song and sends no index", () => {
        it("moves the index to the named song, where the stored queue holds it", async () => {
            const user = await newUser("named-moves");
            await save(user.id, { playbackType: "track", queue: withGone, currentIndex: 0 }).expect(200);

            await save(user.id, { playbackType: "track", trackId: `${S}s3` }).expect(200);

            expect(await storedIndex(user.id)).toBe(3);
            expect((await prisma.playbackState.findUnique({ where: { userId: user.id } }))?.trackId).toBe(`${S}s3`);
        });

        it("keeps the stored index when the song is not in the stored queue, or the save names none", async () => {
            const user = await newUser("named-absent");
            await save(user.id, { playbackType: "track", queue: withGone, currentIndex: 2 }).expect(200);

            await save(user.id, { playbackType: "track", trackId: `${S}s4` }).expect(200);
            expect(await storedIndex(user.id)).toBe(2);
            await save(user.id, { playbackType: "track", trackId: null }).expect(200);
            expect(await storedIndex(user.id)).toBe(2);
            await save(user.id, { playbackType: "track", trackId: "" }).expect(200);
            expect(await storedIndex(user.id)).toBe(2);
        });

        it("with the song twice in the queue, keeps the place nearest the stored index", async () => {
            const user = await newUser("named-twice");
            await save(user.id, { playbackType: "track", queue: [song("s1"), song("s2"), song("s1"), song("s3")], currentIndex: 3 }).expect(200);

            await save(user.id, { playbackType: "track", trackId: `${S}s1` }).expect(200);

            expect(await storedIndex(user.id)).toBe(2);
        });

        it("stores 0 for a person with no stored queue", async () => {
            const user = await newUser("named-noqueue");

            await save(user.id, { playbackType: "track", trackId: `${S}s1` }).expect(200);

            expect(await storedIndex(user.id)).toBe(0);
        });
    });

    it("counts the index after the entries without an id are dropped, for a save that sends the queue", async () => {
        const user = await newUser("idx-dropped");
        await save(user.id, { playbackType: "track", queue: [{ title: "no id" }, song("s1"), null, song("s2"), song("s3")], currentIndex: 3 }).expect(200);
        expect(await storedIds(user.id)).toEqual([`${S}s1`, `${S}s2`, `${S}s3`]);
        // The client's index 3 was s2 (counting the entries as it sent them).
        expect(await storedIndex(user.id)).toBe(1);
    });

    it("waits for a queue being written and points into that one, so the index never outruns the queue", async () => {
        const user = await newUser("idx-lock");
        await save(user.id, { playbackType: "track", queue }).expect(200);

        let partial!: Promise<unknown>;
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "userId" FROM "PlaybackState" WHERE "userId" = ${user.id} FOR UPDATE`;
            partial = save(user.id, { playbackType: "track", currentIndex: 2 }).then((r) => r);
            await untilLockWait(`"PlaybackState"`);
            await tx.playbackState.update({ where: { userId: user.id }, data: { queue: [song("s1")] } });
        });
        await partial;

        expect(await storedIds(user.id)).toEqual([`${S}s1`]);
        expect(await storedIndex(user.id)).toBe(0);
    });

    it("stores an index past the end of the saved queue as its last song when the save sends no queue", async () => {
        const user = await newUser("idx-past");
        await save(user.id, { playbackType: "track", queue }).expect(200);
        const res = await save(user.id, { playbackType: "track", currentIndex: 40 }).expect(200);
        expect(res.body.currentIndex).toBe(2);
        expect(await storedIndex(user.id)).toBe(2);
    });

    it("keeps an index inside the saved queue, and clamps a negative or fractional one", async () => {
        const user = await newUser("idx-in");
        await save(user.id, { playbackType: "track", queue }).expect(200);
        await save(user.id, { playbackType: "track", currentIndex: 1 }).expect(200);
        expect(await storedIndex(user.id)).toBe(1);
        await save(user.id, { playbackType: "track", currentIndex: -5 }).expect(200);
        expect(await storedIndex(user.id)).toBe(0);
        await save(user.id, { playbackType: "track", currentIndex: 1.7 }).expect(200);
        expect(await storedIndex(user.id)).toBe(1);
    });

    it("stores 0 when there is no saved queue to point into, for a first save as for a later one", async () => {
        const first = await newUser("idx-first");
        await save(first.id, { playbackType: "track", currentIndex: 7 }).expect(200);
        expect(await storedIndex(first.id)).toBe(0);

        const emptied = await newUser("idx-empty");
        await save(emptied.id, { playbackType: "track", queue }).expect(200);
        await save(emptied.id, { playbackType: "track", queue: [] }).expect(200);
        await save(emptied.id, { playbackType: "track", currentIndex: 3 }).expect(200);
        expect(await storedIndex(emptied.id)).toBe(0);
    });

    it("clamps an index sent with a queue to that queue, as before", async () => {
        const user = await newUser("idx-with");
        await save(user.id, { playbackType: "track", queue, currentIndex: 9 }).expect(200);
        expect(await storedIndex(user.id)).toBe(2);
    });
});

describe("POST /api/playback-state: a save that names the time it saw (expectedUpdatedAt)", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
    const stored = (userId: string) => prisma.playbackState.findUnique({ where: { userId } });
    const song = (n: string) => ({ id: `${S}${n}`, title: n, duration: 100 });

    it("writes when the stored state is still the one seen, and answers the new row", async () => {
        const user = await newUser("cond-ok");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1"), song("s2")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();

        const res = await save(user.id, { playbackType: "track", trackId: `${S}s2`, queue: [song("s1"), song("s2")], currentIndex: 1, expectedUpdatedAt: seen });

        expect(res.status).toBe(200);
        expect(res.body.trackId).toBe(`${S}s2`);
        expect(res.body.currentIndex).toBe(1);
        expect((await stored(user.id))!.trackId).toBe(`${S}s2`);
    });

    it("refuses with 409 and the current state when another save came in since, and writes nothing", async () => {
        const user = await newUser("cond-stale");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1"), song("s2")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();
        await save(user.id, { playbackType: "track", trackId: `${S}s3`, queue: [song("s3")], currentIndex: 0 }).expect(200);

        const res = await save(user.id, { playbackType: "track", trackId: `${S}s2`, queue: [song("s2")], currentIndex: 0, expectedUpdatedAt: seen });

        expect(res.status).toBe(409);
        expect(res.body.state.trackId).toBe(`${S}s3`);
        expect(typeof res.body.error).toBe("string");
        expect((await stored(user.id))!.trackId).toBe(`${S}s3`);
    });

    it("refuses with 409 and no state when the state was cleared since, and does not bring it back", async () => {
        const user = await newUser("cond-cleared");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();
        await prisma.playbackState.deleteMany({ where: { userId: user.id } });

        const res = await save(user.id, { playbackType: "track", trackId: `${S}s1`, expectedUpdatedAt: seen });

        expect(res.status).toBe(409);
        expect(res.body.state).toBeNull();
        expect(await stored(user.id)).toBeNull();
    });

    it("lets only one of two saves naming the same time write", async () => {
        const user = await newUser("cond-race");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();

        const answers = await Promise.all([
            save(user.id, { playbackType: "track", trackId: `${S}s2`, queue: [song("s2")], currentIndex: 0, expectedUpdatedAt: seen }),
            save(user.id, { playbackType: "track", trackId: `${S}s3`, queue: [song("s3")], currentIndex: 0, expectedUpdatedAt: seen }),
        ]);

        expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    });

    it("guards a save without a queue (an index only) the same way", async () => {
        const user = await newUser("cond-index");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1"), song("s2")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, isShuffle: true }).expect(200);

        const res = await save(user.id, { playbackType: "track", trackId: `${S}s2`, currentIndex: 1, expectedUpdatedAt: seen });

        expect(res.status).toBe(409);
        expect((await stored(user.id))!.currentIndex).toBe(0);
    });

    it("checks the time inside the lock an index-only save takes: a save landing while it waits makes it 409", async () => {
        const user = await newUser("cond-locked");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1"), song("s2")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();

        let waiting!: Promise<request.Response>;
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "userId" FROM "PlaybackState" WHERE "userId" = ${user.id} FOR UPDATE`;
            waiting = save(user.id, { playbackType: "track", trackId: `${S}s2`, currentIndex: 1, expectedUpdatedAt: seen }).then((r) => r);
            await untilLockWait(`"PlaybackState"`);
            await tx.playbackState.update({ where: { userId: user.id }, data: { trackId: `${S}s3` } });
        });

        expect((await waiting).status).toBe(409);
        const row = (await stored(user.id))!;
        expect(row.trackId).toBe(`${S}s3`);
        expect(row.currentIndex).toBe(0);
    });

    it("answers a save the state as a read of it shows it: the reply equals the GET that follows", async () => {
        const user = await newUser("cond-shape");
        // `gone` has no file: a read leaves it out of the queue, so a raw row would differ from the GET.
        const queue = [song("s1"), { id: `${S}gone`, title: "gone", duration: 100 }, song("s2")];

        const plain = await save(user.id, { playbackType: "track", trackId: `${S}s2`, queue, currentIndex: 2 }).expect(200);
        const read = await request(app).get("/api/playback-state").set("x-user", user.id).expect(200);
        expect(plain.body).toEqual(read.body);
        expect(plain.body.queue.map((q: { id: string }) => q.id)).toEqual([`${S}s1`, `${S}s2`]);
        expect(plain.body.currentIndex).toBe(1);

        const conditional = await save(user.id, { playbackType: "track", trackId: `${S}s1`, currentIndex: 0, expectedUpdatedAt: read.body.updatedAt }).expect(200);
        const readAgain = await request(app).get("/api/playback-state").set("x-user", user.id).expect(200);
        expect(conditional.body).toEqual(readAgain.body);
    });

    it("answers 400 for a time that is not a date, and writes nothing", async () => {
        const user = await newUser("cond-bad");
        const res = await save(user.id, { playbackType: "track", trackId: `${S}s1`, expectedUpdatedAt: "yesterday" });
        expect(res.status).toBe(400);
        expect(await stored(user.id)).toBeNull();
    });

    it("answers 400 for a time that is null or not a string, rather than saving without the check", async () => {
        const user = await newUser("cond-nonstring");
        for (const expectedUpdatedAt of [null, 1_700_000_000_000, true, {}]) {
            const res = await save(user.id, { playbackType: "track", trackId: `${S}s1`, expectedUpdatedAt });
            expect(res.status).toBe(400);
        }
        expect(await stored(user.id)).toBeNull();
    });

    it("leaves a save that names no time as it was: it writes whatever is stored", async () => {
        const user = await newUser("cond-none");
        await save(user.id, { playbackType: "track", trackId: `${S}s1` }).expect(200);
        await save(user.id, { playbackType: "track", trackId: `${S}s2` }).expect(200);
        expect((await stored(user.id))!.trackId).toBe(`${S}s2`);
    });
});

describe("POST /api/playback-state: the songs of a saved queue are Kima's own", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
    const entry = (n: string) => ({ id: `${S}${n}`, title: "client says", duration: 1, artist: { id: "x", name: "client artist" }, album: { id: "y", title: "client album" } });
    const storedEntries = async (userId: string) =>
        ((await prisma.playbackState.findUnique({ where: { userId } }))?.queue as Array<{ id: string; title: string; artist: { name: string }; album: { title: string }; duration: number }> | null) ?? [];

    it("stores what Kima knows of each song, not what the client sent, and leaves out the ids Kima does not know", async () => {
        const user = await newUser("own-details");

        const res = await save(user.id, { playbackType: "track", queue: [entry("s1"), { id: `${S}nosuch`, title: "ghost" }, entry("s2")], currentIndex: 0 }).expect(200);

        const stored = await storedEntries(user.id);
        expect(stored.map((e) => [e.id, e.title, e.artist.name, e.album.title, e.duration])).toEqual([
            [`${S}s1`, "s1", "Save Artist", "Save Album", 100],
            [`${S}s2`, "s2", "Save Artist", "Save Album", 100],
        ]);
        expect(res.body.queue.map((q: { id: string }) => q.id)).toEqual([`${S}s1`, `${S}s2`]);
    });

    it("carries the index past the ids left out, onto the song that stands in for an unknown current one", async () => {
        const user = await newUser("own-index");

        await save(user.id, { playbackType: "track", queue: [{ id: `${S}nosuch` }, entry("s1"), { id: `${S}nosuch2` }, entry("s2"), entry("s3")], currentIndex: 3 }).expect(200);
        const row = await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } });
        expect([row.currentIndex, (row.queue as Array<{ id: string }>).map((e) => e.id)]).toEqual([1, [`${S}s1`, `${S}s2`, `${S}s3`]]);

        await save(user.id, { playbackType: "track", queue: [entry("s1"), { id: `${S}nosuch` }, entry("s2")], currentIndex: 1 }).expect(200);
        expect((await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } })).currentIndex).toBe(1);
    });

    it("stores no queue when no id sent is a known song", async () => {
        const user = await newUser("own-none");
        await save(user.id, { playbackType: "track", queue: [entry("s1")] }).expect(200);

        await save(user.id, { playbackType: "track", queue: [{ id: `${S}nosuch` }], queueSource: "album:a" }).expect(200);

        const row = await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } });
        expect([row.queue, row.queueSource, row.currentIndex]).toEqual([null, null, 0]);
    });

    // "Discover is only Discover": a song on a Discover album is never kept in a queue. A song whose file is gone, or
    // that was read as corrupt, is kept (it may come back) and hidden when the queue is read.
    it("never stores a Discover song, and keeps a missing or corrupt library song, hidden on read", async () => {
        const user = await newUser("own-discover");

        const res = await save(user.id, { playbackType: "track", queue: [entry("s1"), entry("d1"), entry("gone"), entry("bad"), entry("s2")], currentIndex: 4 }).expect(200);

        expect((await storedEntries(user.id)).map((e) => e.id)).toEqual([`${S}s1`, `${S}gone`, `${S}bad`, `${S}s2`]);
        expect((await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } })).currentIndex).toBe(3);
        expect(res.body.queue.map((q: { id: string }) => q.id)).toEqual([`${S}s1`, `${S}s2`]);
        expect(res.body.currentIndex).toBe(1);
    });

    it("names the song now current when the one a track save names was left out or cut, and keeps the named song otherwise", async () => {
        const user = await newUser("own-named");
        const stored = async () => (await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } })).trackId;

        await save(user.id, { playbackType: "track", trackId: `${S}d1`, queue: [entry("s1"), entry("d1"), entry("s2")], currentIndex: 1 }).expect(200);
        expect(await stored()).toBe(`${S}s2`);

        await save(user.id, { playbackType: "track", trackId: `${S}nosuch`, queue: [entry("s1"), entry("s2")], currentIndex: 0 }).expect(200);
        expect(await stored()).toBe(`${S}s1`);

        await save(user.id, { playbackType: "track", trackId: `${S}s2`, queue: [entry("s1"), entry("s2")], currentIndex: 1 }).expect(200);
        expect(await stored()).toBe(`${S}s2`);

        await save(user.id, { playbackType: "track", queue: [entry("s1"), entry("s2")], currentIndex: 0 }).expect(200);
        expect(await stored()).toBe(`${S}s2`);
    });

    it("cuts the queue to the limit after the ids left out", async () => {
        const user = await newUser("own-limit");
        const before = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { maxQueueLength: true } });
        try {
            await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", maxQueueLength: 100 }, update: { maxQueueLength: 100 } });
            invalidateSystemSettingsCache();
            const queue = [{ id: `${S}nosuch` }, ...Array.from({ length: 101 }, () => entry("s1"))];

            await save(user.id, { playbackType: "track", queue, currentIndex: 0 }).expect(200);

            expect(await storedEntries(user.id)).toHaveLength(100);
        } finally {
            await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: before?.maxQueueLength ?? 10000 } });
            invalidateSystemSettingsCache();
        }
    });
});

describe("POST /api/playback-state: a save that sends a queue holds its songs and meets the library sweep", () => {
    const MIN = 60_000;
    const sweepSong = `${S}sweep`;
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);

    beforeEach(async () => {
        await prisma.track.create({
            data: { id: sweepSong, albumId: `${S}alb`, title: "sweep", trackNo: 1, duration: 100, filePath: `/tmp/${S}sweep.flac`, fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
        });
    });
    afterEach(async () => {
        await prisma.removalLog.deleteMany({ where: { filePath: { startsWith: `/tmp/${S}` } } });
        await prisma.track.deleteMany({ where: { id: sweepSong } });
    });

    // The sweep holds the rows of the songs it retires until it commits. A save reading one before then would store it
    // after: whether the person's saved queue holds it (the sweep waits on their row), or does not, or they have no row.
    it.each(["no state row", "a row without a queue", "a row whose queue lacks the song", "a row whose queue holds the song"])(
        "waits for the sweep, then stores only the songs that remain, for a person with %s",
        async (rowKind) => {
            const user = await prisma.user.create({ data: { username: `${PREFIX}-sweep-${rowKind.replace(/\W+/g, "")}`, passwordHash: "x", role: "user" } });
            if (rowKind === "a row without a queue") await prisma.playbackState.create({ data: { userId: user.id, playbackType: "track" } });
            if (rowKind === "a row whose queue lacks the song") {
                await prisma.playbackState.create({ data: { userId: user.id, playbackType: "track", queue: [{ id: `${S}s1`, title: "s1" }], currentIndex: 0 } });
            }
            if (rowKind === "a row whose queue holds the song") {
                await prisma.playbackState.create({ data: { userId: user.id, playbackType: "track", queue: [{ id: sweepSong, title: "sweep" }], currentIndex: 0 } });
            }

            let answer!: Promise<request.Response>;
            await prisma.$transaction(async (tx) => {
                expect((await reconcileDeletedTracks(tx, new Date(Date.now() - MIN))).removed).toBe(1);
                answer = save(user.id, { playbackType: "track", queue: [{ id: `${S}s1` }, { id: sweepSong }, { id: `${S}s2` }], currentIndex: 2 }).then((r) => r);
                await untilLockWait(`FOR KEY SHARE`);
            });

            expect((await answer).status).toBe(200);
            const row = await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } });
            expect([(row.queue as Array<{ id: string }>).map((e) => e.id), row.currentIndex]).toEqual([[`${S}s1`, `${S}s2`], 1]);
        },
    );
});

describe("POST /api/playback-state: the queue limit is read before the transaction opens", () => {
    // A save holding a pooled connection must not wait for a second one: the limit is read first.
    it("reads the limit outside the transaction, for a save that sends a queue", async () => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-limit-before`, passwordHash: "x", role: "user" } });
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
            await request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", queue: [{ id: `${S}s1` }] }).expect(200);
        } finally {
            transaction.mockRestore();
            settings.mockRestore();
        }

        expect(opened).toBe(1);
        expect(readsInside).toEqual([false]);
    });
});

describe("POST /api/playback-state: an id that is no string", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);

    it.each(["trackId", "audiobookId", "podcastId"])("answers 400 for a %s that is present and is no string or null, and writes nothing", async (field) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-ids-${field}`, passwordHash: "x", role: "user" } });
        const logged = expectLog("warn");

        for (const value of [7, true, {}, ["a"], 0, false]) {
            const res = await save(user.id, { playbackType: "track", [field]: value });
            expect([field, res.status, res.body]).toEqual([field, 400, { error: "Invalid request" }]);
        }

        expect(logged.mock.calls.some((call) => String(call[0]).includes(`${field}: text or null required`))).toBe(true);

        expect(await prisma.playbackState.findUnique({ where: { userId: user.id } })).toBeNull();
    });

    it.each(["trackId", "audiobookId", "podcastId"])("still takes a %s that is a string, null, empty or left out", async (field) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-ids-ok-${field}`, passwordHash: "x", role: "user" } });

        for (const body of [{ [field]: null }, { [field]: "" }, {}]) {
            await save(user.id, { playbackType: "track", ...body }).expect(200);
        }
    });
});

describe("GET /api/playback-state/limit", () => {
    it("answers a newly saved limit at once, not one the server read earlier", async () => {
        const before = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { maxQueueLength: true } });
        try {
            await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", maxQueueLength: 10000 }, update: { maxQueueLength: 10000 } });
            invalidateSystemSettingsCache();
            expect((await request(app).get("/api/playback-state/limit").set("x-user", "anyone")).body.maxQueueLength).toBe(10000);

            await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: 2500 } });
            invalidateSystemSettingsCache();
            expect((await request(app).get("/api/playback-state/limit").set("x-user", "anyone")).body.maxQueueLength).toBe(2500);
        } finally {
            await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: before?.maxQueueLength ?? 10000 } });
            invalidateSystemSettingsCache();
        }
    });
});
