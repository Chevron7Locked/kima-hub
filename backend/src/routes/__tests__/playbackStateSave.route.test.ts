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
import { invalidateSystemSettingsCache, QUEUE_LENGTH } from "../../utils/systemSettings";
import { entriesOf } from "../../services/savedQueue";
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
    // Their episodes go with them.
    await prisma.podcast.deleteMany({ where: { id: { startsWith: S } } });
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

    it("maps a shown index through the stored queue when the save names no song", async () => {
        const user = await newUser("idx-map");
        await save(user.id, { playbackType: "track", queue: withGone }).expect(200);
        await save(user.id, { playbackType: "track", currentIndex: 2 }).expect(200);
        expect(await storedIndex(user.id)).toBe(3);
    });

    it("leaves the state as it is when the save names a song the stored queue does not hold, whether or not it sends an index", async () => {
        const user = await newUser("idx-notheld");
        await save(user.id, { playbackType: "track", queue: withGone, currentIndex: 2 }).expect(200);
        const before = await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } });
        await prisma.playbackState.update({ where: { userId: user.id }, data: { position: 9000 } });

        await save(user.id, { playbackType: "track", trackId: `${S}s4`, currentIndex: 1 }).expect(200);
        await save(user.id, { playbackType: "track", trackId: `${S}s4` }).expect(200);
        await save(user.id, { playbackType: "track", trackId: `${S}nosuch`, currentIndex: 0 }).expect(200);

        const after = await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } });
        expect([after.trackId, after.currentIndex, after.position]).toEqual([before.trackId, before.currentIndex, 9000]);
        expect(after.trackId).toBe(`${S}s2`);
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

        it("stores index 0 and no song for a person with no stored queue, which holds no song to name", async () => {
            const user = await newUser("named-noqueue");

            await save(user.id, { playbackType: "track", trackId: `${S}s1` }).expect(200);

            const state = await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } });
            expect([state.currentIndex, state.trackId]).toEqual([0, null]);
        });
    });

    it("stores the entry the index lands on as the current song, whether or not the save names one", async () => {
        const user = await newUser("idx-song");
        await save(user.id, { playbackType: "track", queue, currentIndex: 0 }).expect(200);
        const trackId = async () => (await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } })).trackId;

        await save(user.id, { playbackType: "track", currentIndex: 2 }).expect(200);
        expect(await trackId()).toBe(`${S}s3`);
        await save(user.id, { playbackType: "track", currentIndex: 1, trackId: null }).expect(200);
        expect(await trackId()).toBe(`${S}s2`);
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

    it("keeps an index inside the saved queue, and a whole number sent as a float", async () => {
        const user = await newUser("idx-in");
        await save(user.id, { playbackType: "track", queue }).expect(200);
        await save(user.id, { playbackType: "track", currentIndex: 1 }).expect(200);
        expect(await storedIndex(user.id)).toBe(1);
        await save(user.id, { playbackType: "track", currentIndex: 2.0 }).expect(200);
        expect(await storedIndex(user.id)).toBe(2);
        await save(user.id, { playbackType: "track", currentIndex: null }).expect(200);
        expect(await storedIndex(user.id)).toBe(2);
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
        expectLog("warn");
        const user = await newUser("cond-bad");
        const res = await save(user.id, { playbackType: "track", trackId: `${S}s1`, expectedUpdatedAt: "yesterday" });
        expect(res.status).toBe(400);
        expect(await stored(user.id)).toBeNull();
    });

    it("answers 400 for a time that is null or not a string, rather than saving without the check", async () => {
        expectLog("warn");
        const user = await newUser("cond-nonstring");
        for (const expectedUpdatedAt of [null, 1_700_000_000_000, true, {}]) {
            const res = await save(user.id, { playbackType: "track", trackId: `${S}s1`, expectedUpdatedAt });
            expect(res.status).toBe(400);
        }
        expect(await stored(user.id)).toBeNull();
    });

    it("leaves a save that names no time as it was: it writes whatever is stored", async () => {
        const user = await newUser("cond-none");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [{ id: `${S}s1` }, { id: `${S}s2` }] }).expect(200);
        await save(user.id, { playbackType: "track", trackId: `${S}s2` }).expect(200);
        expect((await stored(user.id))!.trackId).toBe(`${S}s2`);
    });
});

// The position is a Subsonic client's place in the current song (`getPlayQueue`). The web player sends none, so a web
// save that starts another queue or moves to another song must not leave an earlier position beside the new song.
describe("POST /api/playback-state: the position in the current song", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
    const song = (n: string) => ({ id: `${S}${n}`, title: n, duration: 100 });
    const position = async (userId: string) => (await prisma.playbackState.findUniqueOrThrow({ where: { userId } })).position;
    // A state a Subsonic client left, 9 seconds into the first of three songs.
    const withPosition = async (name: string) => {
        const user = await newUser(name);
        await prisma.playbackState.create({
            data: { userId: user.id, playbackType: "track", queue: [song("s1"), song("s2"), song("s3")], currentIndex: 0, trackId: `${S}s1`, position: 9000 },
        });
        return user;
    };

    it("keeps the position when a save sends the queue and the place the state already holds", async () => {
        const user = await withPosition("pos-resave");

        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1"), song("s2"), song("s3")], currentIndex: 0 }).expect(200);

        expect(await position(user.id)).toBe(9000);
    });

    it("keeps the position when the ids Kima does not hold are all that differ from the stored queue", async () => {
        const user = await withPosition("pos-unknown");

        await save(user.id, { playbackType: "track", queue: [song("s1"), { id: `${S}nosuch`, title: "x" }, song("s2"), song("s3")], currentIndex: 0 }).expect(200);

        expect(await position(user.id)).toBe(9000);
    });

    it.each([
        ["one id changed", [{ id: "s1" }, { id: "s2" }, { id: "s4" }], 0],
        ["the order changed", [{ id: "s2" }, { id: "s1" }, { id: "s3" }], 1],
        ["a song was added", [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }], 0],
        ["a song was taken out", [{ id: "s1" }, { id: "s2" }], 0],
        ["the entry changed, the list the same", [{ id: "s1" }, { id: "s2" }, { id: "s3" }], 1],
    ])("resets the position when a save sends a queue where %s", async (name, entries, index) => {
        const user = await withPosition(`pos-diff-${name.replace(/\W+/g, "")}`);

        await save(user.id, { playbackType: "track", queue: entries.map((e) => song(e.id)), currentIndex: index }).expect(200);

        expect(await position(user.id)).toBe(0);
    });

    it("starts at position 0 when a save with a queue creates the state", async () => {
        const user = await newUser("pos-first");

        await save(user.id, { playbackType: "track", queue: [song("s1")], currentIndex: 0 }).expect(200);

        expect(await position(user.id)).toBe(0);
    });

    it("resets the position when a save without a queue moves to another entry, and keeps it when the entry is the same", async () => {
        const user = await withPosition("pos-move");

        await save(user.id, { playbackType: "track", trackId: `${S}s1`, currentIndex: 0 }).expect(200);
        expect(await position(user.id)).toBe(9000);

        await save(user.id, { playbackType: "track", trackId: `${S}s3`, currentIndex: 2 }).expect(200);
        expect(await position(user.id)).toBe(0);
    });

    it("resets the position when a save names a song and no index and that song is another entry", async () => {
        const user = await withPosition("pos-named");

        await save(user.id, { playbackType: "track", trackId: `${S}s2` }).expect(200);

        expect(await position(user.id)).toBe(0);
    });

    it("keeps the position for a save that leaves the place alone", async () => {
        const user = await withPosition("pos-alone");

        await save(user.id, { playbackType: "track", isShuffle: true }).expect(200);
        await save(user.id, { playbackType: "audiobook", audiobookId: "book", queue: [], currentIndex: 0, trackId: null }).expect(200);

        expect(await position(user.id)).toBe(9000);
    });

    it("keeps the position when a save names the entry the state is already on, counted from a shown index", async () => {
        const user = await withPosition("pos-same");

        await save(user.id, { playbackType: "track", currentIndex: 0 }).expect(200);

        expect(await position(user.id)).toBe(9000);
    });

    it("resets the position when a save names the time it saw and moves the place", async () => {
        const user = await withPosition("pos-timed");
        const seen = (await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } })).updatedAt.toISOString();

        await save(user.id, { playbackType: "track", trackId: `${S}s2`, currentIndex: 1, expectedUpdatedAt: seen }).expect(200);

        expect(await position(user.id)).toBe(0);
    });
});

// A song whose file went missing or that was read as corrupt stays in the stored queue and is hidden when it is read
// (it may come back). The web player is shown the playable songs only, so what it saves back is the shown queue: a
// save keeps the hidden songs the stored queue holds, at their place beside the songs they sat between.
describe("POST /api/playback-state: a save of the queue the player was shown", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const song = (n: string) => ({ id: `${S}${n}`, title: n, duration: 100 });
    const shown = (...ids: string[]) => ids.map(song);
    const row = (userId: string) => prisma.playbackState.findUniqueOrThrow({ where: { userId } });
    const storedIds = async (userId: string) => entriesOf((await row(userId)).queue).map((e) => e.id.slice(S.length));
    // Stored: s1, gone, s2, bad, s3 with the player on s2 (stored place 2, shown place 1), 9 seconds in. The player is
    // shown s1, s2, s3.
    const withHidden = async (name: string, ids: string[] = ["s1", "gone", "s2", "bad", "s3"], index = 2) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
        await prisma.playbackState.create({
            data: { userId: user.id, playbackType: "track", queue: shown(...ids), currentIndex: index, trackId: `${S}${ids[index]}`, position: 9000 },
        });
        return user;
    };

    it("keeps the hidden songs, the place and the position when it sends back the queue it was shown", async () => {
        const user = await withHidden("hid-resave");

        const res = await save(user.id, { playbackType: "track", queue: shown("s1", "s2", "s3"), currentIndex: 1 }).expect(200);

        expect(await storedIds(user.id)).toEqual(["s1", "gone", "s2", "bad", "s3"]);
        const after = await row(user.id);
        expect([after.currentIndex, after.trackId, after.position]).toEqual([2, `${S}s2`, 9000]);
        expect(res.body.queue.map((q: { id: string }) => q.id)).toEqual([`${S}s1`, `${S}s2`, `${S}s3`]);
        expect(res.body.currentIndex).toBe(1);
    });

    it("maps the shown place back onto the stored queue", async () => {
        const user = await withHidden("hid-index");

        await save(user.id, { playbackType: "track", queue: shown("s1", "s2", "s3"), currentIndex: 2 }).expect(200);

        const after = await row(user.id);
        expect([after.currentIndex, after.trackId, after.position]).toEqual([4, `${S}s3`, 0]);
    });

    it("keeps a hidden song at the head of the queue before the song it sat in front of", async () => {
        const user = await withHidden("hid-head", ["gone", "s1", "s2"], 1);

        await save(user.id, { playbackType: "track", queue: shown("s1", "s2"), currentIndex: 0 }).expect(200);

        expect(await storedIds(user.id)).toEqual(["gone", "s1", "s2"]);
        const after = await row(user.id);
        expect([after.currentIndex, after.position]).toEqual([1, 9000]);
    });

    it.each([
        ["a song is taken out", ["s1", "s3"], 1, ["s1", "gone", "bad", "s3"]],
        ["a song is added at the end", ["s1", "s2", "s3", "s4"], 1, ["s1", "gone", "s2", "bad", "s3", "s4"]],
        ["a song is added in the middle", ["s1", "s4", "s2", "s3"], 2, ["s1", "gone", "s4", "s2", "bad", "s3"]],
        ["the songs are reordered", ["s3", "s2", "s1"], 1, ["s3", "s2", "s1", "gone", "bad"]],
    ])("keeps the hidden songs beside their neighbours when %s", async (name, queue, index, expected) => {
        const user = await withHidden(`hid-edit-${name.replace(/\W+/g, "")}`);

        await save(user.id, { playbackType: "track", queue: shown(...queue), currentIndex: index }).expect(200);

        expect(await storedIds(user.id)).toEqual(expected);
    });

    it("takes none of the hidden songs into a queue that shares none of their neighbours, or into an empty one", async () => {
        const user = await withHidden("hid-new");

        await save(user.id, { playbackType: "track", queue: shown("s4"), currentIndex: 0 }).expect(200);
        expect(await storedIds(user.id)).toEqual(["s4"]);

        await save(user.id, { playbackType: "track", queue: shown("s1", "s2"), currentIndex: 0 }).expect(200);
        expect(await storedIds(user.id)).toEqual(["s1", "s2"]);

        await save(user.id, { playbackType: "track", queue: [], currentIndex: 0 }).expect(200);
        expect((await row(user.id)).queue).toBeNull();
    });

    it("does not bring back a hidden song that is gone from Kima, and never one that was never stored", async () => {
        const user = await withHidden("hid-gone", ["s1", "nosuch", "s2"], 2);

        await save(user.id, { playbackType: "track", queue: shown("s1", "s2"), currentIndex: 1 }).expect(200);

        expect(await storedIds(user.id)).toEqual(["s1", "s2"]);
    });

    it("leaves a hidden song a save sends itself where it was sent, once", async () => {
        const user = await withHidden("hid-sent");

        await save(user.id, { playbackType: "track", queue: shown("s1", "gone", "s2", "s3"), currentIndex: 2 }).expect(200);

        expect(await storedIds(user.id)).toEqual(["s1", "gone", "s2", "bad", "s3"]);
    });

    it("leaves a hidden song a save sends out of the stored order once, where it was sent", async () => {
        const user = await withHidden("hid-sent-moved");

        await save(user.id, { playbackType: "track", queue: shown("s3", "gone", "s1"), currentIndex: 0 }).expect(200);

        expect(await storedIds(user.id)).toEqual(["s3", "gone", "s1", "bad"]);
    });

    it("resets the position when the player is on the song standing in for a hidden current one, which this save makes the stored current", async () => {
        const user = await withHidden("hid-standin", ["s1", "gone", "s2"], 1);

        await save(user.id, { playbackType: "track", queue: shown("s1", "s2"), currentIndex: 1 }).expect(200);

        expect(await storedIds(user.id)).toEqual(["s1", "gone", "s2"]);
        const after = await row(user.id);
        expect([after.currentIndex, after.trackId, after.position]).toEqual([2, `${S}s2`, 0]);
    });

    it("lets the songs it is shown fill the limit before the hidden ones take a place", async () => {
        const user = await withHidden("hid-limit", ["s1", "gone"], 0);
        const before = await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { maxQueueLength: true } });
        try {
            await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", maxQueueLength: QUEUE_LENGTH.min }, update: { maxQueueLength: QUEUE_LENGTH.min } });
            invalidateSystemSettingsCache();

            await save(user.id, { playbackType: "track", queue: Array.from({ length: QUEUE_LENGTH.min }, () => song("s1")), currentIndex: 0 }).expect(200);

            expect(await storedIds(user.id)).toEqual(Array.from({ length: QUEUE_LENGTH.min }, () => "s1"));
        } finally {
            if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: before.maxQueueLength } });
            else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
            invalidateSystemSettingsCache();
        }
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

    it("stores the queue's current entry as the song, whatever the save names (left out, cut, another, none) and none when no entry is left", async () => {
        const user = await newUser("own-named");
        const stored = async () => (await prisma.playbackState.findUniqueOrThrow({ where: { userId: user.id } })).trackId;

        await save(user.id, { playbackType: "track", trackId: `${S}d1`, queue: [entry("s1"), entry("d1"), entry("s2")], currentIndex: 1 }).expect(200);
        expect(await stored()).toBe(`${S}s2`);

        await save(user.id, { playbackType: "track", trackId: `${S}nosuch`, queue: [entry("s1"), entry("s2")], currentIndex: 0 }).expect(200);
        expect(await stored()).toBe(`${S}s1`);

        await save(user.id, { playbackType: "track", trackId: `${S}s2`, queue: [entry("s1"), entry("s2")], currentIndex: 1 }).expect(200);
        expect(await stored()).toBe(`${S}s2`);

        // The current song is the queue's current entry, whether the save names that song, another, none or leaves it out.
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [entry("s1"), entry("s2")], currentIndex: 1 }).expect(200);
        expect(await stored()).toBe(`${S}s2`);

        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [entry("d1"), entry("nosuch")], currentIndex: 0 }).expect(200);
        expect(await stored()).toBeNull();

        await save(user.id, { playbackType: "track", queue: [entry("s1"), entry("s2")], currentIndex: 0 }).expect(200);
        expect(await stored()).toBe(`${S}s1`);

        await save(user.id, { playbackType: "track", trackId: null, queue: [entry("s1"), entry("s2")], currentIndex: 1 }).expect(200);
        expect(await stored()).toBe(`${S}s2`);

        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [], currentIndex: 0 }).expect(200);
        expect(await stored()).toBeNull();
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

describe("POST /api/playback-state: an index that is no place in a queue", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);

    // Each row: what the index was sent as, and the reason the log carries.
    const invalidRequests: Array<[string, unknown]> = [
        ["a negative number", -1],
        ["a fraction", 1.5],
        ["text", "2"],
        ["a boolean", true],
        ["an object", {}],
        ["a list", [1]],
    ];

    it.each(invalidRequests)("answers 400 for a currentIndex that is %s, logs the reason, and writes nothing", async (_name, value) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-badidx-${_name.replace(/\W+/g, "")}`, passwordHash: "x", role: "user" } });
        const logged = expectLog("warn");

        for (const playbackType of ["track", "audiobook", "podcast"]) {
            const res = await save(user.id, { playbackType, currentIndex: value, queue: [{ id: `${S}s1` }] });
            expect([playbackType, res.status, res.body]).toEqual([playbackType, 400, { error: "Invalid request" }]);
        }

        expect(logged.mock.calls.some((call) => String(call[0]).includes("currentIndex: a whole number of 0 or more required"))).toBe(true);
        expect(await prisma.playbackState.findUnique({ where: { userId: user.id } })).toBeNull();
    });

    it.each([["0", 0], ["a large whole number", 40], ["left out", undefined], ["null", null]])("still takes a currentIndex that is %s", async (_name, value) => {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-goodidx-${_name.replace(/\W+/g, "")}`, passwordHash: "x", role: "user" } });

        await save(user.id, { playbackType: "track", currentIndex: value }).expect(200);
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

describe("POST /api/playback-state: a save holds only the songs it stores", () => {
    const LIM = QUEUE_LENGTH.min;
    const lim = (n: number) => `${S}lim${String(n).padStart(3, "0")}`;
    const all = Array.from({ length: LIM + 5 }, (_, n) => lim(n));
    let limitBefore: number | undefined;
    let users = 0;

    beforeAll(async () => {
        await prisma.track.createMany({
            data: all.map((id, n) => ({ id, albumId: `${S}alb`, title: id, trackNo: n + 1, duration: 100, filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1 })),
        });
        limitBefore = (await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { maxQueueLength: true } }))?.maxQueueLength;
        await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", maxQueueLength: LIM }, update: { maxQueueLength: LIM } });
        invalidateSystemSettingsCache();
    });
    afterAll(async () => {
        await prisma.systemSettings.update({ where: { id: "default" }, data: { maxQueueLength: limitBefore ?? 10000 } });
        invalidateSystemSettingsCache();
    });

    const storedIds = async (userId: string) => ((await prisma.playbackState.findUnique({ where: { userId } }))?.queue as Array<{ id: string }> | null)?.map((e) => e.id);

    // The library sweep holds the rows of the songs it retires until it commits; a save holding a song waits for it.
    // Here another transaction holds the rows of `lockedIds` the same way, and the save either waits or does not.
    async function finishesWhileHeld(lockedIds: string[], body: object): Promise<{ finished: boolean; userId: string }> {
        const user = await prisma.user.create({ data: { username: `${PREFIX}-held-${users++}`, passwordHash: "x", role: "user" } });
        let finished = false;
        let answer!: Promise<request.Response>;
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Track" WHERE id = ANY(${lockedIds}::text[]) ORDER BY id FOR UPDATE`;
            answer = request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", ...body }).then((r) => r);
            finished = await Promise.race([answer.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500))]);
        });
        expect((await answer).status).toBe(200);
        return { finished, userId: user.id };
    }

    it("does not wait for a song it leaves out: a Discover song or an id Kima does not know", async () => {
        const { finished, userId } = await finishesWhileHeld([`${S}d1`], { queue: [{ id: lim(0) }, { id: `${S}d1` }, { id: `${S}unknownid` }, { id: lim(1) }], currentIndex: 0 });

        expect(finished).toBe(true);
        expect(await storedIds(userId)).toEqual([lim(0), lim(1)]);
    });

    it("does not wait for a song the limit cuts off, nor for one left out before the cut", async () => {
        const { finished, userId } = await finishesWhileHeld([lim(LIM), lim(LIM + 4), `${S}d1`], { queue: [`${S}d1`, ...all].map((id) => ({ id })), currentIndex: 1 });

        expect(finished).toBe(true);
        expect(await storedIds(userId)).toEqual(all.slice(0, LIM));
    });

    it("fills the places of a song the sweep deletes while the save waits for it, from the songs after the cut", async () => {
        const gone = `${S}limgone`;
        await prisma.track.create({ data: { id: gone, albumId: `${S}alb`, title: gone, trackNo: 950, duration: 100, filePath: `/tmp/${gone}.flac`, fileModified: new Date(), fileSize: 1 } });
        const user = await prisma.user.create({ data: { username: `${PREFIX}-held-refill`, passwordHash: "x", role: "user" } });
        let answer!: Promise<request.Response>;
        await prisma.$transaction(async (tx) => {
            // The delete is not committed, so the save's first read still sees the song and counts it among the stored.
            await tx.track.delete({ where: { id: gone } });
            answer = request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", queue: [gone, ...all].map((id) => ({ id })), currentIndex: 1 }).then((r) => r);
            await new Promise((resolve) => setTimeout(resolve, 500));
        });

        expect((await answer).status).toBe(200);
        expect(await storedIds(user.id)).toEqual(all.slice(0, LIM));
    });

    it("counts the places held, not the songs: a repeat after the window does not use up the place of a song the sweep deletes", async () => {
        const gone = `${S}limgone2`;
        await prisma.track.create({ data: { id: gone, albumId: `${S}alb`, title: gone, trackNo: 951, duration: 100, filePath: `/tmp/${gone}.flac`, fileModified: new Date(), fileSize: 1 } });
        const user = await prisma.user.create({ data: { username: `${PREFIX}-held-repeat`, passwordHash: "x", role: "user" } });
        let answer!: Promise<request.Response>;
        const ids = [gone, ...all.slice(0, LIM), all[0]];
        await prisma.$transaction(async (tx) => {
            await tx.track.delete({ where: { id: gone } });
            answer = request(app).post("/api/playback-state").set("x-user", user.id).send({ playbackType: "track", queue: ids.map((id) => ({ id })), currentIndex: 0 }).then((r) => r);
            await new Promise((resolve) => setTimeout(resolve, 500));
        });

        expect((await answer).status).toBe(200);
        expect(await storedIds(user.id)).toEqual(all.slice(0, LIM));
    });

    it("still waits for a song it stores, even a missing one", async () => {
        expect((await finishesWhileHeld([lim(1)], { queue: [{ id: lim(0) }, { id: lim(1) }], currentIndex: 0 })).finished).toBe(false);
        expect((await finishesWhileHeld([`${S}gone`], { queue: [{ id: lim(0) }, { id: `${S}gone` }], currentIndex: 0 })).finished).toBe(false);
    });
});

describe("POST /api/playback-state: a save that is not a track save leaves the queue alone", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const entry = (n: string) => ({ id: `${S}${n}`, title: "t" });
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
    const rowOf = async (userId: string) => {
        const row = await prisma.playbackState.findUniqueOrThrow({ where: { userId } });
        return [row.playbackType, (row.queue as Array<{ id: string }> | null)?.map((e) => e.id), row.currentIndex, row.queueSource];
    };

    // The web client sends the same fields on a book or an episode as on a song, with an empty queue and index 0, and
    // restores the server's queue whatever the type: a book save must not wipe the music queue.
    it.each([
        ["audiobook", "an empty queue", { audiobookId: "book-1" }],
        ["audiobook", "songs", { audiobookId: "book-1", queue: [{ id: `${S}s4` }], currentIndex: 0 }],
        ["podcast", "an empty queue", { queue: [], currentIndex: 0, trackId: null }],
        ["podcast", "songs", { queue: [{ id: `${S}s4` }], currentIndex: 0, trackId: `${S}s4` }],
    ])("a %s save sending %s changes the type and keeps the stored queue, index and source", async (playbackType, _what, body) => {
        const user = await newUser(`nontrack-${playbackType}-${_what.replace(/\W+/g, "")}`);
        await save(user.id, { playbackType: "track", queue: [entry("s1"), entry("s2"), entry("s3")], currentIndex: 2, queueSource: "album:a" }).expect(200);

        const res = await save(user.id, { playbackType, queue: [], currentIndex: 0, ...body }).expect(200);

        expect(await rowOf(user.id)).toEqual([playbackType, [`${S}s1`, `${S}s2`, `${S}s3`], 2, "album:a"]);
        expect(res.body.queue.map((q: { id: string }) => q.id)).toEqual([`${S}s1`, `${S}s2`, `${S}s3`]);
    });

    it("a first save of a book stores no queue", async () => {
        const user = await newUser("nontrack-first");

        await save(user.id, { playbackType: "audiobook", audiobookId: "book-1", queue: [entry("s1")], currentIndex: 0 }).expect(200);

        expect(await rowOf(user.id)).toEqual(["audiobook", undefined, 0, null]);
    });

    it("a track save still replaces the queue", async () => {
        const user = await newUser("nontrack-track");
        await save(user.id, { playbackType: "track", queue: [entry("s1")], currentIndex: 0 }).expect(200);

        await save(user.id, { playbackType: "track", queue: [entry("s2"), entry("s3")], currentIndex: 1 }).expect(200);

        expect(await rowOf(user.id)).toEqual(["track", [`${S}s2`, `${S}s3`], 1, null]);
    });
});

describe("POST /api/playback-state: the ids a save names are checked", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
    const POD = `${S}pod1`;
    const OTHER = `${S}pod2`;
    const stored = (userId: string) => prisma.playbackState.findUnique({ where: { userId } });
    const sweepSong = `${S}sweepnamed`;
    const MIN = 60_000;

    beforeAll(async () => {
        for (const [id, episode] of [[POD, `${S}ep1`], [OTHER, `${S}ep2`]]) {
            await prisma.podcast.create({
                data: {
                    id, feedUrl: `https://example.test/${id}`, title: id,
                    episodes: { create: { id: episode, guid: episode, title: episode, audioUrl: `https://example.test/${episode}.mp3`, publishedAt: new Date() } },
                },
            });
        }
    });

    // A song a save names must be one the stored queue holds, so one a queue could hold: a library song (a missing one
    // too, it may come back). Any other leaves the stored current song as it is; an empty id names none.
    it.each([
        ["a library song", `${S}s1`, `${S}s1`],
        ["a library song whose file is gone", `${S}gone`, `${S}gone`],
        ["a Discover song", `${S}d1`, `${S}s2`],
        ["an id Kima does not know", `${S}nosuch`, `${S}s2`],
        ["a library song the stored queue does not hold", `${S}s4`, `${S}s2`],
        ["an empty id", "", null],
    ])("stores %s as the current song: %s", async (label, trackId, expected) => {
        for (const extra of [{}, { currentIndex: 0 }]) {
            const user = await newUser(`named-${label.replace(/\W+/g, "")}-${Object.keys(extra).length}`);
            await save(user.id, { playbackType: "track", trackId: `${S}s2`, queue: [{ id: `${S}s2` }, { id: `${S}s1` }, { id: `${S}gone` }], currentIndex: 0 }).expect(200);

            await save(user.id, { playbackType: "track", trackId, ...extra }).expect(200);

            // An empty id with no index clears the song; with an index the stored song is the entry the index is on.
            const want = trackId === "" && "currentIndex" in extra ? `${S}s2` : expected;
            expect([label, Object.keys(extra).length, (await stored(user.id))!.trackId]).toEqual([label, Object.keys(extra).length, want]);
        }
    });

    it.each([
        ["an episode of that podcast", `${POD}:${S}ep1`, `${POD}:${S}ep1`],
        ["an episode of another podcast", `${POD}:${S}ep2`, null],
        ["an episode that does not exist", `${POD}:${S}nosuch`, null],
        ["a podcast that does not exist", `${S}nosuch:${S}ep1`, null],
        ["an episode id with no podcast named", `${S}ep1`, null],
        ["more than a podcast and an episode", `${POD}:${S}ep1:x`, null],
        ["a podcast with no episode", `${POD}:`, null],
        ["an empty id", "", null],
    ])("stores %s as the current podcast episode: %s", async (label, podcastId, expected) => {
        const user = await newUser(`podcast-${label.replace(/\W+/g, "")}`);
        await save(user.id, { playbackType: "podcast", podcastId: `${POD}:${S}ep1` }).expect(200);

        await save(user.id, { playbackType: "podcast", podcastId }).expect(200);

        expect((await stored(user.id))!.podcastId).toBe(expected);
    });

    it("leaves the book id as sent: books come from Audiobookshelf, which Kima does not hold", async () => {
        const user = await newUser("book-anything");

        await save(user.id, { playbackType: "audiobook", audiobookId: "abs-li-anything" }).expect(200);

        expect((await stored(user.id))!.audiobookId).toBe("abs-li-anything");
    });

    it("leaves an id it is not sent alone", async () => {
        const user = await newUser("ids-omitted");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [{ id: `${S}s1` }], podcastId: `${POD}:${S}ep1` }).expect(200);

        await save(user.id, { playbackType: "track", isShuffle: true }).expect(200);

        const row = await stored(user.id);
        expect([row!.trackId, row!.podcastId]).toEqual([`${S}s1`, `${POD}:${S}ep1`]);
    });

    // The sweep holds the rows of the songs it retires until it commits: a save naming one waits, then finds it gone.
    it.each([["no index", {}], ["an index", { currentIndex: 0 }]])("waits for the sweep before storing a song it retires, a save sending %s", async (_name, extra) => {
        await prisma.track.create({
            data: { id: sweepSong, albumId: `${S}alb`, title: "sweep", trackNo: 1, duration: 100, filePath: `/tmp/${S}sweepnamed.flac`, fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
        });
        try {
            const user = await newUser(`named-sweep-${_name.replace(/\W+/g, "")}`);
            await save(user.id, { playbackType: "track", queue: [{ id: `${S}s1` }], currentIndex: 0 }).expect(200);

            let answer!: Promise<request.Response>;
            await prisma.$transaction(async (tx) => {
                expect((await reconcileDeletedTracks(tx, new Date(Date.now() - MIN))).removed).toBe(1);
                answer = save(user.id, { playbackType: "track", trackId: sweepSong, ...extra }).then((r) => r);
                await untilLockWait(`FOR KEY SHARE`);
            });

            expect((await answer).status).toBe(200);
            expect((await stored(user.id))!.trackId).not.toBe(sweepSong);
        } finally {
            await prisma.removalLog.deleteMany({ where: { filePath: { startsWith: `/tmp/${S}` } } });
            await prisma.track.deleteMany({ where: { id: sweepSong } });
        }
    });
});

describe("POST /api/playback-state: a time that is not an ISO date", () => {
    const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
    const stored = (userId: string) => prisma.playbackState.findUnique({ where: { userId } });
    const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });

    it.each(["1", "2026-01-01", "yesterday", "2026-13-45T00:00:00Z", " 2026-01-01T00:00:00Z", "2026-01-01T00:00:00", "Thu, 01 Jan 2026 00:00:00 GMT", ""])(
        "answers 400 for %j, logs it as a refused request, and writes nothing",
        async (expectedUpdatedAt) => {
            const logged = expectLog("warn");
            const user = await newUser(`iso-${expectedUpdatedAt.replace(/\W+/g, "") || "empty"}`);
            await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [{ id: `${S}s1` }, { id: `${S}s2` }] }).expect(200);

            const res = await save(user.id, { playbackType: "track", trackId: `${S}s2`, expectedUpdatedAt });

            expect([res.status, res.body]).toEqual([400, { error: "Invalid request" }]);
            expect(logged.mock.calls.some((call) => String(call[0]).includes("expectedUpdatedAt"))).toBe(true);
            expect((await stored(user.id))!.trackId).toBe(`${S}s1`);
        },
    );

    it("takes the time as the server writes it, and the same instant written with an offset", async () => {
        const user = await newUser("iso-ok");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [{ id: `${S}s1` }, { id: `${S}s2` }] }).expect(200);

        const seen = (await stored(user.id))!.updatedAt;
        await save(user.id, { playbackType: "track", trackId: `${S}s2`, expectedUpdatedAt: seen.toISOString().replace("Z", "+00:00") }).expect(200);

        expect((await stored(user.id))!.trackId).toBe(`${S}s2`);
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
