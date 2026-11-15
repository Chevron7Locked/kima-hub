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
    for (const [id, missing] of [["s1", false], ["s2", false], ["s3", false], ["s4", false], ["gone", true]] as const) {
        await prisma.track.create({
            data: {
                id: `${S}${id}`, albumId: `${S}alb`, title: id, trackNo: 1, duration: 100, filePath: `/tmp/${S}${id}.flac`,
                fileModified: new Date(), fileSize: 1, missingSince: missing ? new Date() : null,
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
        const queue = [
            { id: "t1", title: "file title", displayTitle: "edited title", duration: 200 },
            { id: "t2", title: "no edit", duration: 100 },
        ];

        await request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", queue }).expect(200);

        const saved = await prisma.playbackState.findUnique({ where: { userId: user.id } });
        expect((saved?.queue as Array<{ title: string; displayTitle: string | null }>).map((q) => [q.title, q.displayTitle])).toEqual([
            ["file title", "edited title"],
            ["no edit", null],
        ]);
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

describe("GET /api/playback-state/limit", () => {
    it("answers a newly saved limit at once, not one the server read earlier", async () => {
        const before = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { maxQueueLength: true } });
        try {
            await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", maxQueueLength: 10000 }, update: { maxQueueLength: 10000 } });
            expect((await request(app).get("/api/playback-state/limit").set("x-user", "anyone")).body.maxQueueLength).toBe(10000);

            await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: 2500 } });
            expect((await request(app).get("/api/playback-state/limit").set("x-user", "anyone")).body.maxQueueLength).toBe(2500);
        } finally {
            await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: before?.maxQueueLength ?? 10000 } });
        }
    });
});
