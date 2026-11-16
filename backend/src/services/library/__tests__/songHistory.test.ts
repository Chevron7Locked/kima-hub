/**
 * What becomes of a song's history when the song leaves the library, and what a returning recording gets back. Through the
 * delete module's interface (`deleteSongs`, `deleteAlbums`, `deleteArtists`) and the song-history module's `adoptKeptPlays`.
 * Real database; no mocks.
 */
import { prisma } from "../../../utils/db";
import { lockPlayHistory } from "../../playRecording";
import { deleteAlbums, deleteArtists, deleteSongs } from "../albumDelete";
import { adoptKeptPlays } from "../songHistory";

const P = "zz-hist_";
const id = (n: string) => `${P}${n}`;
const REC = "11111111-1111-4111-8111-111111111111";
const REC2 = "22222222-2222-4222-8222-222222222222";

async function clear(): Promise<void> {
    await prisma.shareLink.deleteMany({ where: { token: { startsWith: P } } });
    await prisma.playlist.deleteMany({ where: { userId: id("user") } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.play.deleteMany({ where: { userId: { in: [id("user"), id("user2")] } } });
}

async function artist(n: string, name = `${P}${n}`): Promise<string> {
    return (await prisma.artist.create({ data: { id: id(n), name, identityKey: id(`${n}-key`) } })).id;
}

interface SongOpts {
    recording?: string | null;
    mime?: string;
    bitrate?: number;
    corrupt?: boolean;
    missing?: boolean;
    title?: string;
    duration?: number;
}

async function album(n: string, artistId: string, location: "LIBRARY" | "DISCOVER", songs: Record<string, SongOpts>): Promise<void> {
    await prisma.album.create({
        data: { id: id(n), rgMbid: id(`${n}-rg`), artistId, identityKey: id(`${n}-key`), title: `Album ${n}`, primaryType: "Album", location },
    });
    let no = 1;
    for (const [s, o] of Object.entries(songs)) {
        await prisma.track.create({
            data: {
                id: id(s), albumId: id(n), title: o.title ?? `Song ${s}`, trackNo: no++, duration: o.duration ?? 200,
                filePath: `/${P}outside/${n}/${s}.flac`, fileModified: new Date(), fileSize: 1,
                recordingMbid: o.recording === undefined ? REC : o.recording,
                mime: o.mime ?? "audio/mpeg", bitrate: o.bitrate ?? 128, corrupt: o.corrupt ?? false,
                ...(o.missing ? { missingSince: new Date() } : {}),
            },
        });
    }
}

let n = 0;
const play = (song: string, extra: { at?: Date; user?: string } = {}) =>
    prisma.play.create({ data: { id: id(`play${n++}`), userId: extra.user ?? id("user"), trackId: id(song), playedAt: extra.at ?? new Date(Date.now() - 86_400_000 * (n + 1)) } });
const playsOf = (song: string) => prisma.play.count({ where: { trackId: id(song) } });
const kept = () => prisma.play.findMany({ where: { userId: id("user"), trackId: null }, orderBy: { id: "asc" } });

beforeAll(async () => {
    await clear();
    await prisma.user.deleteMany({ where: { id: { in: [id("user"), id("user2")] } } });
    await prisma.user.create({ data: { id: id("user"), username: id("user"), passwordHash: "x" } });
    await prisma.user.create({ data: { id: id("user2"), username: id("user2"), passwordHash: "x" } });
});
afterEach(clear);
afterAll(async () => {
    await clear();
    await prisma.user.deleteMany({ where: { id: { in: [id("user"), id("user2")] } } });
});

describe("a song that leaves the library, its recording still on another library album", () => {
    it("hands its plays, like, playlist place and share link to that copy", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await album("new", a, "LIBRARY", { copy: {} });
        await play("gone");
        await play("gone");
        await prisma.likedTrack.create({ data: { userId: id("user"), trackId: id("gone") } });
        const list = await prisma.playlist.create({
            data: { userId: id("user"), name: `${P}pl`, items: { create: [{ trackId: id("gone"), sort: 0, rank: "a" }] } },
        });
        await prisma.shareLink.create({ data: { token: id("tok"), entityType: "track", entityId: id("gone"), createdBy: id("user") } });

        await deleteSongs([id("gone")]);

        expect(await playsOf("copy")).toBe(2);
        expect(await kept()).toEqual([]);
        expect(await prisma.likedTrack.count({ where: { userId: id("user"), trackId: id("copy") } })).toBe(1);
        expect((await prisma.playlistItem.findMany({ where: { playlistId: list.id } })).map((i) => i.trackId)).toEqual([id("copy")]);
        expect((await prisma.shareLink.findUniqueOrThrow({ where: { token: id("tok") } })).entityId).toBe(id("copy"));
    });

    it("does the same when a whole album is deleted, and when an artist is", async () => {
        const a = await artist("a");
        const b = await artist("b");
        await album("old", a, "LIBRARY", { gone: {} });
        await album("new", b, "LIBRARY", { copy: {} });
        await play("gone");

        await deleteAlbums([id("old")]);
        expect(await playsOf("copy")).toBe(1);

        await album("old2", a, "LIBRARY", { gone2: {} });
        await play("gone2");
        await deleteArtists([a]);
        expect(await playsOf("copy")).toBe(2);
        expect(await kept()).toEqual([]);
    });

    it("chooses the best copy: playable, then lossless, then bitrate, then the lower id", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await album("c1", a, "LIBRARY", { corruptflac: { mime: "audio/flac", corrupt: true } });
        await album("c2", a, "LIBRARY", { lossy: { bitrate: 320 } });
        await album("c3", a, "LIBRARY", { zlossless: { mime: "audio/flac", bitrate: 900 }, alossless: { mime: "audio/flac", bitrate: 900 } });
        await album("c4", a, "LIBRARY", { moved: { missing: true, mime: "audio/flac" } });
        await play("gone");

        await deleteSongs([id("gone")]);

        expect(await playsOf("alossless")).toBe(1);
    });

    it("never chooses a Discover copy: the plays are kept instead", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await album("disc", a, "DISCOVER", { copy: {} });
        await play("gone");
        await prisma.likedTrack.create({ data: { userId: id("user"), trackId: id("gone") } });

        await deleteSongs([id("gone")]);

        expect(await playsOf("copy")).toBe(0);
        expect(await kept()).toHaveLength(1);
        expect(await prisma.likedTrack.count({ where: { trackId: id("copy") } })).toBe(0);
    });

    it("hands nothing on when the leaving song is a Discover song, whatever library copy of its recording there is", async () => {
        const a = await artist("a");
        await album("disc", a, "DISCOVER", { gone: {} });
        await album("lib", a, "LIBRARY", { copy: {} });
        await play("gone");
        await prisma.likedTrack.create({ data: { userId: id("user"), trackId: id("gone") } });

        await deleteAlbums([id("disc")]);

        expect(await playsOf("copy")).toBe(0);
        expect(await prisma.likedTrack.count({ where: { trackId: id("copy") } })).toBe(0);
        // Discover is only Discover: its plays go with the song, and are not kept.
        expect(await prisma.play.count({ where: { userId: id("user") } })).toBe(0);
    });

    it("matches by recording id alone: a song with none, or another recording, is no copy", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {}, bare: { recording: null } });
        await album("new", a, "LIBRARY", { other: { recording: REC2, title: "Song gone" }, bare2: { recording: null, title: "Song bare" } });
        await play("gone");
        await play("bare");

        await deleteSongs([id("gone"), id("bare")]);

        expect(await playsOf("other")).toBe(0);
        expect(await playsOf("bare2")).toBe(0);
        expect(await kept()).toHaveLength(2);
    });

    it("never hands history to a song deleted in the same call", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {}, twin: {} });
        await play("gone");

        await deleteAlbums([id("old")]);

        expect(await kept()).toHaveLength(1);
    });

    it("keeps the earliest like when both songs were liked", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await album("new", a, "LIBRARY", { copy: {} });
        await album("old2", a, "LIBRARY", { gone2: { recording: REC2 } });
        await album("new2", a, "LIBRARY", { copy2: { recording: REC2 } });
        const early = new Date("2024-01-01T00:00:00Z");
        const late = new Date("2025-01-01T00:00:00Z");
        await prisma.likedTrack.createMany({
            data: [
                { userId: id("user"), trackId: id("gone"), likedAt: early },
                { userId: id("user"), trackId: id("copy"), likedAt: late },
                { userId: id("user"), trackId: id("gone2"), likedAt: late },
                { userId: id("user"), trackId: id("copy2"), likedAt: early },
            ],
        });

        await deleteSongs([id("gone"), id("gone2")]);

        const likes = await prisma.likedTrack.findMany({ where: { userId: id("user") }, orderBy: { trackId: "asc" } });
        expect(likes.map((l) => [l.trackId, l.likedAt.toISOString()])).toEqual([
            [id("copy"), early.toISOString()],
            [id("copy2"), early.toISOString()],
        ]);
    });
});

describe("a song that leaves with no copy", () => {
    it("leaves its plays behind with what is needed to count them, and loses its likes and share links", async () => {
        const a = await artist("a", "The Band");
        await album("old", a, "LIBRARY", { gone: { title: "Lost Song", duration: 245 } });
        const when = new Date("2025-03-01T10:00:00Z");
        await play("gone", { at: when });
        await prisma.likedTrack.create({ data: { userId: id("user"), trackId: id("gone") } });
        await prisma.shareLink.create({ data: { token: id("tok"), entityType: "track", entityId: id("gone"), createdBy: id("user") } });

        await deleteSongs([id("gone")]);

        const rows = await kept();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            playedAt: when,
            keptTitle: "Lost Song",
            keptArtistName: "The Band",
            keptAlbumTitle: "Album old",
            keptRecordingMbid: REC,
            keptDuration: 245,
        });
        expect(await prisma.likedTrack.count({ where: { userId: id("user") } })).toBe(0);
        expect(await prisma.shareLink.count({ where: { token: id("tok") } })).toBe(0);
    });

    it("keeps the plays of every listener of a library song, and deletes a Discover song's with it", async () => {
        const a = await artist("a");
        await album("lib", a, "LIBRARY", { l: {} });
        await album("disc", a, "DISCOVER", { d: {} });
        await play("l");
        await play("l", { user: id("user2") });
        await play("d");

        await deleteAlbums([id("lib"), id("disc")]);

        const rows = await prisma.play.findMany({ where: { userId: { in: [id("user"), id("user2")] } } });
        expect(rows.map((r) => [r.userId, r.trackId, r.keptTitle]).sort()).toEqual(
            [[id("user"), null, "Song l"], [id("user2"), null, "Song l"]].sort(),
        );
    });

    it("leaves a song's plays when its artist is deleted", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await play("gone");

        await deleteArtists([a]);

        expect(await kept()).toHaveLength(1);
    });
});

describe("adoptKeptPlays: a returning recording takes back its kept plays", () => {
    it("attaches the library plays kept for that recording to its song and clears what was kept", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await play("gone");
        await play("gone");
        await deleteSongs([id("gone")]);
        expect(await kept()).toHaveLength(2);

        await album("back", a, "LIBRARY", { returned: {} });
        const adopted = await adoptKeptPlays();

        expect(adopted).toBe(2);
        expect(await playsOf("returned")).toBe(2);
        expect(await kept()).toEqual([]);
        expect(await prisma.play.findFirstOrThrow({ where: { trackId: id("returned") } })).toMatchObject({
            keptTitle: null, keptArtistName: null, keptAlbumTitle: null, keptRecordingMbid: null, keptDuration: null,
        });
    });

    it("takes the plays of one recording when given its id, and leaves the others", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { one: {}, two: { recording: REC2 } });
        await play("one");
        await play("two");
        await deleteSongs([id("one"), id("two")]);
        await album("back", a, "LIBRARY", { returned: {}, returned2: { recording: REC2 } });

        await adoptKeptPlays(undefined, [REC2]);

        expect(await playsOf("returned2")).toBe(1);
        expect(await playsOf("returned")).toBe(0);
        expect(await kept()).toHaveLength(1);
    });

    it("never gives a Discover song a play, and a Discover song's plays were never kept to give", async () => {
        const a = await artist("a");
        await album("lib", a, "LIBRARY", { one: {} });
        await album("disc", a, "DISCOVER", { two: { recording: REC2 } });
        await play("one");
        await play("two");
        await deleteAlbums([id("lib"), id("disc")]);
        await album("back", a, "DISCOVER", { returned: {} });
        await album("lib2", a, "LIBRARY", { returned2: { recording: REC2 } });

        await adoptKeptPlays();

        expect(await playsOf("returned")).toBe(0);
        expect(await playsOf("returned2")).toBe(0);
        expect(await kept()).toHaveLength(1);
        expect(await prisma.play.count({ where: { userId: id("user") } })).toBe(1);
    });

    it("runs inside the transaction it is given", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await play("gone");
        await deleteSongs([id("gone")]);
        await album("back", a, "LIBRARY", { returned: {} });

        await expect(
            prisma.$transaction(async (tx) => {
                expect(await adoptKeptPlays(tx)).toBe(1);
                throw new Error("roll back");
            }),
        ).rejects.toThrow("roll back");

        expect(await kept()).toHaveLength(1);
    });
});


/** Songs with no history of their own, to make a delete's id list longer than one batch (5000 ids). */
async function filler(albumNo: string, artistId: string, count: number): Promise<string[]> {
    await prisma.album.create({
        data: { id: id(albumNo), rgMbid: id(`${albumNo}-rg`), artistId, identityKey: id(`${albumNo}-key`), title: `Album ${albumNo}`, primaryType: "Album", location: "LIBRARY" },
    });
    const ids = Array.from({ length: count }, (_, i) => id(`${albumNo}-f${i}`));
    await prisma.track.createMany({
        data: ids.map((songId, i) => ({
            id: songId, albumId: id(albumNo), title: songId, trackNo: i + 1, duration: 200,
            filePath: `/${P}outside/${albumNo}/${i}.flac`, fileModified: new Date(), fileSize: 1,
        })),
    });
    return ids;
}

describe("a delete that goes in more than one batch", () => {
    it("never hands history to a song a later batch deletes: the plays of both are kept", async () => {
        const a = await artist("a");
        await album("old1", a, "LIBRARY", { first: {} });
        await album("old2", a, "LIBRARY", { last: {} });
        const bulk = await filler("bulk", a, 4999);
        await play("first");
        await play("last");

        // `first` is in the first batch of 5000, `last` alone in the second.
        const result = await deleteSongs([id("first"), ...bulk, id("last")]);

        expect(result.songs).toBe(5001);
        const rows = await kept();
        expect(rows.map((r) => r.keptTitle).sort()).toEqual(["Song first", "Song last"]);
        expect(await prisma.track.count({ where: { id: { in: [id("first"), id("last")] } } })).toBe(0);
    });

    it("hands both to a copy outside the delete", async () => {
        const a = await artist("a");
        await album("old1", a, "LIBRARY", { first: {} });
        await album("old2", a, "LIBRARY", { last: {} });
        await album("new", a, "LIBRARY", { copy: {} });
        const bulk = await filler("bulk", a, 4999);
        await play("first");
        await play("last");

        await deleteSongs([id("first"), ...bulk, id("last")]);

        expect(await playsOf("copy")).toBe(2);
        expect(await kept()).toEqual([]);
    });

    it("does the same for albums: an album of a later batch is no copy", async () => {
        const a = await artist("a");
        await album("old1", a, "LIBRARY", { first: {} });
        await album("old2", a, "LIBRARY", { last: {} });
        await play("first");
        await play("last");
        const empties = Array.from({ length: 4999 }, (_, i) => id(`empty${i}`));
        await prisma.album.createMany({
            data: empties.map((albumId) => ({
                id: albumId, rgMbid: `${albumId}-rg`, artistId: a, identityKey: `${albumId}-key`, title: albumId, primaryType: "Album", location: "LIBRARY" as const,
            })),
        });

        const result = await deleteAlbums([id("old1"), ...empties, id("old2")]);

        expect(result.albums).toBe(5001);
        expect((await kept()).map((r) => r.keptTitle).sort()).toEqual(["Song first", "Song last"]);
    });
});

/** Holds a listener's exclusive play-history lock (a repair under way) until `release()` is called. */
function repairing(userId: string): { started: Promise<void>; release: () => void; done: Promise<unknown> } {
    let release = () => {};
    let started = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const began = new Promise<void>((resolve) => (started = resolve));
    const done = prisma.$transaction(async (tx) => {
        await lockPlayHistory(tx, userId, { exclusive: true });
        started();
        await gate;
    });
    return { started: began, release, done };
}

describe("a delete honours the play-history lock of the listeners whose plays it moves or keeps", () => {
    it("leaves a song with no copy for a later pass while its listener's history is being repaired, when it cannot wait", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {}, free: { recording: REC2 } });
        await play("gone");
        const repair = repairing(id("user"));
        await repair.started;
        try {
            const result = await deleteSongs([id("gone")], { canWait: false });
            expect(result.left).toEqual([id("gone")]);
            expect(result.songs).toBe(0);
            expect(await playsOf("gone")).toBe(1);
        } finally {
            repair.release();
            await repair.done;
        }
        // Once the repair is done the same call goes through.
        const again = await deleteSongs([id("gone")], { canWait: false });
        expect(again.left).toEqual([]);
        expect(await kept()).toHaveLength(1);
    });

    it("leaves a song whose plays would move to a copy, and deletes the others of the same call", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {}, other: { recording: REC2 } });
        await album("new", a, "LIBRARY", { copy: {} });
        await play("gone");
        const repair = repairing(id("user"));
        await repair.started;
        try {
            const result = await deleteSongs([id("gone"), id("other")], { canWait: false });
            expect(result.left).toEqual([id("gone")]);
            expect(result.songs).toBe(1);
            expect(await playsOf("gone")).toBe(1);
            expect(await playsOf("copy")).toBe(0);
        } finally {
            repair.release();
            await repair.done;
        }
    });

    it("waits for the repair when the caller can wait", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await play("gone");
        const repair = repairing(id("user"));
        await repair.started;
        let finished = false;
        const deleting = deleteSongs([id("gone")]).then((r) => {
            finished = true;
            return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(finished).toBe(false);
        expect(await playsOf("gone")).toBe(1);

        repair.release();
        await repair.done;
        const result = await deleting;

        expect(result.songs).toBe(1);
        expect(result.left).toEqual([]);
        expect(await kept()).toHaveLength(1);
    });

    it("an album delete waits too", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await play("gone");
        const repair = repairing(id("user"));
        await repair.started;
        let finished = false;
        const deleting = deleteAlbums([id("old")]).then((r) => {
            finished = true;
            return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(finished).toBe(false);

        repair.release();
        await repair.done;
        await deleting;

        expect(await kept()).toHaveLength(1);
    });

    it("does not wait for a listener of other songs", async () => {
        const a = await artist("a");
        await album("old", a, "LIBRARY", { gone: {} });
        await play("gone", { user: id("user2") });
        const repair = repairing(id("user"));
        await repair.started;
        try {
            const result = await deleteSongs([id("gone")], { canWait: false });
            expect(result.left).toEqual([]);
            expect(result.songs).toBe(1);
        } finally {
            repair.release();
            await repair.done;
        }
    });
});
