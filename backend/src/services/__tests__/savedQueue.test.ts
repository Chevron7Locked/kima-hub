/**
 * The saved queue's interface: what a web save is read as, what a save, a read and a clear do to a person's playback
 * state, and what a Subsonic save refuses. Real database. The route tests cover the same saves through HTTP; these
 * hold the module to its own interface, so the route stays a reader of the request and nothing more.
 */
import { prisma } from "../../utils/db";
import {
    clearPlaybackState,
    readPlaybackState,
    readWebSave,
    saveQueueOfIds,
    saveWebState,
    type WebSave,
} from "../savedQueue";

const P = "sqmod";

const song = (id: string) => ({ id: `${P}${id}`, title: id });

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.podcast.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}art`, name: "Module Artist", identityKey: `${P}-a` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, identityKey: `${P}-ak`, title: "Module Album", primaryType: "Album" } });
    await prisma.album.create({ data: { id: `${P}dalb`, artistId: `${P}art`, rgMbid: `${P}-drg`, identityKey: `${P}-dk`, title: "Discover Album", primaryType: "Album", location: "DISCOVER" } });
    for (const [id, corrupt, albumId] of [
        ["s1", false, `${P}alb`], ["s2", false, `${P}alb`], ["s3", false, `${P}alb`], ["bad", true, `${P}alb`], ["d1", false, `${P}dalb`],
    ] as const) {
        await prisma.track.create({
            data: { id: `${P}${id}`, albumId, title: id, trackNo: 1, duration: 100, filePath: `/tmp/${P}${id}.flac`, fileModified: new Date(), fileSize: 1, corrupt },
        });
    }
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

let nth = 0;
async function newUser(): Promise<string> {
    return (await prisma.user.create({ data: { username: `${P}-user-${++nth}`, passwordHash: "x", role: "user" } })).id;
}

/** A request body as the web player sends it, read the way the route reads it; the test fails if it is refused. */
function read(body: Record<string, unknown>): WebSave {
    const parsed = readWebSave({ playbackType: "track", ...body });
    if ("refused" in parsed) throw new Error(`refused: ${parsed.refused.reason}`);
    return parsed.save;
}

const stored = (userId: string) => prisma.playbackState.findUnique({ where: { userId } });

describe("readWebSave", () => {
    it("refuses a playbackType that is not track, audiobook or podcast, with the answer a client is shown", () => {
        const read = readWebSave({ playbackType: "radio" });
        expect(read).toEqual({ refused: { reason: expect.stringContaining("playbackType"), answer: "playbackType must be track, audiobook or podcast" } });
        expect(readWebSave(undefined)).toMatchObject({ refused: expect.anything() });
    });

    it.each([
        ["a time that is not an ISO date and time", { expectedUpdatedAt: "2026-01-01" }, "expectedUpdatedAt"],
        ["a time that is no text", { expectedUpdatedAt: 5 }, "expectedUpdatedAt"],
        ["a fractional index", { currentIndex: 1.5 }, "currentIndex"],
        ["a negative index", { currentIndex: -1 }, "currentIndex"],
        ["an index that is text", { currentIndex: "1" }, "currentIndex"],
        ["a song id that is a number", { trackId: 7 }, "trackId"],
        ["a book id that is an object", { audiobookId: {} }, "audiobookId"],
        ["an episode id that is a number", { podcastId: 3 }, "podcastId"],
    ])("refuses %s, naming the field in the reason", (_name, body, field) => {
        const read = readWebSave({ playbackType: "track", ...body });
        expect(read).toEqual({ refused: { reason: expect.stringContaining(field) } });
    });

    it("leaves out what is not sent, and reads an index or an id of null as none", () => {
        const { save } = readWebSave({ playbackType: "track", currentIndex: null, trackId: null }) as { save: WebSave };
        expect(save.currentIndex).toBeUndefined();
        expect(save.trackId).toBeNull();
        expect(save.queue).toBeUndefined();
        expect(save.seenAt).toBeNull();
        expect(save.queueSource).toBeNull();
    });

    it("keeps a queue source only when it is short text, and a queue only when it is an array", () => {
        expect(read({ queueSource: "album:abc" }).queueSource).toBe("album:abc");
        expect(read({ queueSource: "x".repeat(201) }).queueSource).toBeNull();
        expect(read({ queueSource: "" }).queueSource).toBeNull();
        expect(read({ queueSource: 4 }).queueSource).toBeNull();
        expect(read({ queue: "nope" }).queue).toBeUndefined();
        expect(read({ queue: [] }).queue).toEqual([]);
    });
});

describe("saveWebState", () => {
    it("stores the queue as Kima describes the songs, and the queue's current entry as the current song", async () => {
        const userId = await newUser();
        // The client's own details of a song are never read, and the song Kima does not know is left out.
        const queue = [{ ...song("s1"), title: "stale", artist: { name: "Old" } }, { id: `${P}unknown` }, song("s2"), song("s3")];

        const answer = await saveWebState(userId, read({ queue, currentIndex: 3, isShuffle: true, queueSource: "album:x" }));

        expect("saved" in answer).toBe(true);
        const row = (await stored(userId))!;
        const entries = row.queue as Array<{ id: string; title: string; artist: { name: string } }>;
        expect(entries.map((e) => [e.id, e.title, e.artist.name])).toEqual([
            [`${P}s1`, "s1", "Module Artist"],
            [`${P}s2`, "s2", "Module Artist"],
            [`${P}s3`, "s3", "Module Artist"],
        ]);
        expect([row.currentIndex, row.trackId, row.queueSource, row.isShuffle, row.changedBy]).toEqual([2, `${P}s3`, "album:x", true, "Kima"]);
    });

    it("moves the index back by the entries that had no id, so it still names the song it did", async () => {
        const userId = await newUser();

        await saveWebState(userId, read({ queue: [null, song("s1"), { title: "x" }, song("s2")], currentIndex: 3 }));

        const row = (await stored(userId))!;
        expect([row.currentIndex, row.trackId]).toEqual([1, `${P}s2`]);
    });

    it("leaves a Discover song out of the queue", async () => {
        const userId = await newUser();

        await saveWebState(userId, read({ queue: [song("d1"), song("s1")], currentIndex: 0 }));

        expect(((await stored(userId))!.queue as Array<{ id: string }>).map((e) => e.id)).toEqual([`${P}s1`]);
    });

    it("keeps a stored corrupt song beside its neighbours when a client sends back the queue it was shown without it", async () => {
        const userId = await newUser();
        await prisma.playbackState.create({
            data: { userId, playbackType: "track", queue: [song("s1"), song("bad"), song("s2")], currentIndex: 0, trackId: `${P}s1` },
        });

        await saveWebState(userId, read({ queue: [song("s1"), song("s2")], currentIndex: 1 }));

        const row = (await stored(userId))!;
        expect((row.queue as Array<{ id: string }>).map((e) => e.id)).toEqual([`${P}s1`, `${P}bad`, `${P}s2`]);
        expect([row.currentIndex, row.trackId]).toEqual([2, `${P}s2`]);
    });

    it("answers with the state as a read shows it: the corrupt song is not in the queue shown", async () => {
        const userId = await newUser();
        await prisma.playbackState.create({
            data: { userId, playbackType: "track", queue: [song("s1"), song("bad"), song("s2")], currentIndex: 0, trackId: `${P}s1` },
        });

        const answer = await saveWebState(userId, read({ queue: [song("s1"), song("s2")], currentIndex: 1 }));

        if (!("saved" in answer)) throw new Error("expected a saved state");
        expect((answer.saved!.queue as Array<{ id: string }>).map((e) => e.id)).toEqual([`${P}s1`, `${P}s2`]);
        expect(answer.saved).toEqual(await readPlaybackState(userId));
    });

    it("leaves the stored queue alone on a save with no queue, and on a book's or an episode's save", async () => {
        const userId = await newUser();
        await saveWebState(userId, read({ queue: [song("s1"), song("s2")], currentIndex: 0, queueSource: "album:x" }));

        await saveWebState(userId, read({ isShuffle: true }));
        await saveWebState(userId, read({ playbackType: "audiobook", audiobookId: "book", queue: [], currentIndex: 0 }));

        const row = (await stored(userId))!;
        expect((row.queue as Array<{ id: string }>).map((e) => e.id)).toEqual([`${P}s1`, `${P}s2`]);
        expect([row.queueSource, row.isShuffle, row.audiobookId, row.playbackType]).toEqual(["album:x", true, "book", "audiobook"]);
    });

    it("moves to another entry of the stored queue on a save that names only the index, and starts the position over", async () => {
        const userId = await newUser();
        await saveWebState(userId, read({ queue: [song("s1"), song("s2"), song("s3")], currentIndex: 0 }));
        await prisma.playbackState.update({ where: { userId }, data: { position: 40 } });

        await saveWebState(userId, read({ currentIndex: 2 }));

        const row = (await stored(userId))!;
        expect([row.currentIndex, row.trackId, row.position]).toEqual([2, `${P}s3`, 0]);
    });

    it("changes nothing for a save that names a song the stored queue does not hold", async () => {
        const userId = await newUser();
        await saveWebState(userId, read({ queue: [song("s1"), song("s2")], currentIndex: 1 }));

        await saveWebState(userId, read({ currentIndex: 0, trackId: `${P}s3` }));

        const row = (await stored(userId))!;
        expect([row.currentIndex, row.trackId]).toEqual([1, `${P}s2`]);
    });

    it("stores no id of an episode the podcast does not hold", async () => {
        const userId = await newUser();

        await saveWebState(userId, read({ playbackType: "podcast", podcastId: `${P}pod:missing` }));

        expect((await stored(userId))!.podcastId).toBeNull();
    });

    it("writes while the time it names is the stored time, and answers the stored state, shown, when it is not", async () => {
        const userId = await newUser();
        await saveWebState(userId, read({ trackId: `${P}s1`, queue: [song("s1")] }));
        const seen = (await stored(userId))!.updatedAt;

        const first = await saveWebState(userId, { ...read({ isShuffle: true }), seenAt: seen });
        const stale = await saveWebState(userId, { ...read({ isShuffle: false }), seenAt: seen });

        expect("saved" in first).toBe(true);
        if (!("changed" in stale)) throw new Error("expected a refusal");
        expect(stale.changed).toEqual({ error: "Playback state changed since it was read", state: await readPlaybackState(userId) });
        expect((await stored(userId))!.isShuffle).toBe(true);
    });

    it("never brings back a state that is gone when the save names a time", async () => {
        const userId = await newUser();

        const answer = await saveWebState(userId, { ...read({ isShuffle: true }), seenAt: new Date() });

        expect(answer).toEqual({ changed: { error: "Playback state changed since it was read", state: null } });
        expect(await stored(userId)).toBeNull();
    });
});

describe("readPlaybackState", () => {
    it("is null for a person with no state", async () => {
        expect(await readPlaybackState(await newUser())).toBeNull();
    });

    it("shows the playable songs of the stored queue and the place on them, and leaves what is stored as it is", async () => {
        const userId = await newUser();
        await prisma.playbackState.create({
            data: { userId, playbackType: "track", queue: [song("bad"), song("s1"), song("d1"), song("s2")], currentIndex: 3, trackId: `${P}s2` },
        });

        const shown = await readPlaybackState(userId);

        expect((shown!.queue as Array<{ id: string }>).map((e) => e.id)).toEqual([`${P}s1`, `${P}s2`]);
        expect([shown!.currentIndex, shown!.trackId]).toEqual([1, `${P}s2`]);
        expect(((await stored(userId))!.queue as unknown[]).length).toBe(4);
    });
});

describe("clearPlaybackState", () => {
    it("clears whatever is stored when no time is named, and clearing what is gone succeeds", async () => {
        const userId = await newUser();
        await saveWebState(userId, read({ trackId: `${P}s1`, queue: [song("s1")] }));

        expect(await clearPlaybackState(userId, undefined)).toEqual({ cleared: 1 });
        expect(await stored(userId)).toBeNull();
        expect(await clearPlaybackState(userId, undefined)).toEqual({ cleared: 0 });
    });

    it("clears while the time it names is the stored time, and answers the stored state, shown, when it is not", async () => {
        const userId = await newUser();
        await saveWebState(userId, read({ queue: [song("s1")] }));
        const seen = (await stored(userId))!.updatedAt;
        await saveWebState(userId, read({ isShuffle: true }));

        const stale = await clearPlaybackState(userId, seen.toISOString());

        expect(stale).toEqual({ changed: { error: "Playback state changed since it was read", state: await readPlaybackState(userId) } });
        expect(await stored(userId)).not.toBeNull();
        const current = (await stored(userId))!.updatedAt.toISOString();
        expect(await clearPlaybackState(userId, current)).toEqual({ cleared: 1 });
    });

    it("succeeds for a state that is already gone, even when it names a time", async () => {
        expect(await clearPlaybackState(await newUser(), new Date().toISOString())).toEqual({ cleared: 0 });
    });

    it.each(["1", "2026-01-01", "yesterday", 5, ["a", "b"], ""])("refuses a time that is not an ISO date and time (%j) and clears nothing", async (named) => {
        const userId = await newUser();
        await saveWebState(userId, read({ queue: [song("s1")] }));

        expect(await clearPlaybackState(userId, named)).toEqual({ refused: { reason: expect.stringContaining("expectedUpdatedAt") } });
        expect(await stored(userId)).not.toBeNull();
    });
});

describe("saveQueueOfIds", () => {
    it.each([
        ["a negative index", { clientIndex: -1, position: 0 }],
        ["a fractional index", { clientIndex: 1.5, position: 0 }],
        ["an index that is no number", { clientIndex: Number.NaN, position: 0 }],
        ["a negative position", { clientIndex: 0, position: -1 }],
        ["a fractional position", { clientIndex: 0, position: 0.5 }],
    ])("takes only whole places and positions of 0 or more: %s is refused before the database is touched", async (_name, place) => {
        await expect(saveQueueOfIds("nobody", { ids: [], changedBy: "test", ...place })).rejects.toThrow(TypeError);
    });
});
