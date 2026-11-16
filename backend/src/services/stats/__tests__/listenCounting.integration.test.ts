/**
 * The one way to count plays, asked through the listens module's interface on the real suite database. Every count reads
 * listens (plays folded by the listen rule), of one person's own plays of library songs, with their kept plays
 * attributed wherever a stored recording id or names find a present song.
 */
import { ListenSource, Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { playableSongSql } from "../../../utils/playableSong";
import {
    albumsListenedAtLeast,
    hasListenedSql,
    listenCounts,
    listenedArtists,
    listenedMoreThanSql,
    listenRows,
    neverListenedSql,
    recentListenArtists,
} from "../listens";
import { trackPlayCount } from "../listening";

jest.setTimeout(60_000);

const P = "lc_";
const A = `${P}a`;
const B = `${P}b`;
const id = (s: string) => `${P}${s}`;
const ago = (ms: number) => new Date(Date.now() - ms);
const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Songs: s1..s4 on X's library album (s2 carries a recording id), s5..s6 on Y's, d1 on Z's Discover album, m1 missing and
// c1 corrupt on X's, w1..w2 on W's library album, v1 on V's.
const SONGS: Array<[string, string]> = [
    ["s1", "alb_x"], ["s2", "alb_x"], ["s3", "alb_x"], ["s4", "alb_x"], ["s5", "alb_y"], ["s6", "alb_y"],
    ["d1", "alb_z"], ["m1", "alb_x"], ["c1", "alb_x"], ["w1", "alb_w"], ["w2", "alb_w"], ["v1", "alb_v"],
];
const ARTISTS = ["x", "y", "z", "w", "v"];

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

let n = 0;
const nextId = () => `${P}play_${String(n++).padStart(3, "0")}`;
const play = (user: string, song: string, playedAt: Date, source: ListenSource = "LIBRARY") =>
    ({ id: nextId(), userId: user, trackId: id(song), playedAt, source });
const kept = (user: string, playedAt: Date, names: { title: string; artist: string; album: string; mbid?: string }) => ({
    id: nextId(), userId: user, trackId: null, playedAt,
    keptTitle: names.title, keptArtistName: names.artist, keptAlbumTitle: names.album,
    keptRecordingMbid: names.mbid ?? null, keptDuration: 200,
});

beforeAll(async () => {
    await cleanup();
    for (const u of [A, B]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    for (const a of ARTISTS) {
        await prisma.artist.create({ data: { id: id(`art_${a}`), name: `Counting ${a}`, normalizedName: `counting ${a}`, identityKey: id(`ak_${a}`) } });
        await prisma.album.create({
            data: {
                id: id(`alb_${a}`), rgMbid: id(`rg_${a}`), artistId: id(`art_${a}`), identityKey: id(`ik_${a}`),
                title: `Counting Album ${a}`, primaryType: "Album", location: a === "z" ? "DISCOVER" : "LIBRARY",
            },
        });
    }
    for (const [s, album] of SONGS) {
        await prisma.track.create({
            data: {
                id: id(s), albumId: id(album), title: s, trackNo: 1, duration: 200, filePath: `/tmp/${P}${s}.flac`,
                fileModified: new Date(), fileSize: 1000, missingSince: s === "m1" ? new Date() : null, corrupt: s === "c1",
                recordingMbid: s === "s2" ? id("rec_s2") : null,
            },
        });
    }
    await prisma.play.createMany({
        data: [
            // A: s1 five listens a day apart; s5 two rows ten seconds apart (one listen) and a later one; s3 forty days
            // ago; a Discover play; a play of the missing song and of the corrupt one; a Subsonic play of s4.
            ...[1, 2, 3, 4, 5].map((d) => play(A, "s1", ago(d * DAY))),
            play(A, "s5", ago(10 * DAY)),
            play(A, "s5", ago(10 * DAY - 10 * SECOND)),
            play(A, "s5", ago(HOUR)),
            play(A, "s3", ago(40 * DAY)),
            play(A, "d1", ago(2 * HOUR)),
            play(A, "m1", ago(3 * HOUR)),
            play(A, "c1", ago(4 * HOUR)),
            play(A, "s4", ago(5 * HOUR), "SUBSONIC"),
            // A's kept plays: s2's recording is back (found by recording id), s6 is found by names, one has gone for good.
            kept(A, ago(2 * DAY), { title: "s2", artist: "Gone Artist", album: "Gone Album", mbid: id("rec_s2") }),
            kept(A, ago(3 * DAY), { title: "s2", artist: "Gone Artist", album: "Gone Album", mbid: id("rec_s2") }),
            kept(A, ago(6 * HOUR), { title: "s6", artist: "Counting y", album: "Counting Album y" }),
            kept(A, ago(7 * HOUR), { title: "Lost", artist: "Counting y", album: "Lost Album" }),
            // B: a play of s4, and of the Discover song.
            play(B, "s4", ago(HOUR)),
            play(B, "d1", ago(2 * HOUR)),
            // W: A listened to w1 twice, B to w2 twice; no one listened three times. V: ten seconds apart is one listen.
            play(A, "w1", ago(3 * DAY)), play(A, "w1", ago(2.5 * DAY)),
            play(B, "w2", ago(3 * DAY)), play(B, "w2", ago(2.5 * DAY)),
            play(A, "v1", ago(DAY)), play(A, "v1", ago(DAY - 10 * SECOND)),
        ],
    });
});

afterAll(cleanup);

const rows = (user: string, scope: Parameters<typeof listenRows>[1] = {}) =>
    prisma.$queryRaw<Array<{ trackId: string | null; fkey: string; kept_title: string | null }>>(Prisma.sql`
        ${listenRows(user, scope)}
        SELECT p."trackId", p.fkey, p.kept_title FROM p ORDER BY p."playedAt", p.id`);

const perSong = async (user: string, scope: Parameters<typeof listenRows>[1] = {}) => {
    const counts = new Map<string, number>();
    for (const r of await rows(user, scope)) counts.set(r.fkey, (counts.get(r.fkey) ?? 0) + 1);
    return counts;
};

describe("listen rows", () => {
    it("fold repeats into one listen: three rows of s5, two of them ten seconds apart, are two listens", async () => {
        const counts = await perSong(A);
        expect(counts.get(id("s5"))).toBe(2);
        expect(counts.get(id("v1"))).toBe(1);
        expect(counts.get(id("s1"))).toBe(5);
    });

    it("are this person's own: B's plays do not appear in A's, and A's not in B's", async () => {
        expect([...(await perSong(B)).keys()].sort()).toEqual([id("s4"), id("w2")]);
        expect((await perSong(A)).has(id("w2"))).toBe(false);
    });

    it("leave out the plays of a song on a Discover album", async () => {
        expect((await perSong(A)).has(id("d1"))).toBe(false);
        expect((await perSong(B)).has(id("d1"))).toBe(false);
    });

    it("count a kept play toward the present song it is found by, recording id or names", async () => {
        const counts = await perSong(A);
        expect(counts.get(id("s2"))).toBe(2);
        expect(counts.get(id("s6"))).toBe(1);
        const found = (await rows(A)).filter((r) => r.fkey === id("s2"));
        expect(found.every((r) => r.trackId === id("s2"))).toBe(true);
    });

    it("keep a kept play no present song matches under its stored names, with no song", async () => {
        const lost = (await rows(A)).filter((r) => r.trackId === null);
        expect(lost).toHaveLength(1);
        expect(lost[0].kept_title).toBe("Lost");
    });

    it("fold a lost kept play stored with no duration by the shortest listen window", async () => {
        const base = { ...kept(A, ago(5 * DAY), { title: "Lost", artist: "Counting y", album: "Lost Album" }), keptDuration: null };
        const ids = [base.id, `${base.id}b`, `${base.id}c`];
        await prisma.play.createMany({
            data: [base, { ...base, id: ids[1], playedAt: ago(5 * DAY - 10 * SECOND) }, { ...base, id: ids[2], playedAt: ago(5 * DAY - 60 * SECOND) }],
        });
        try {
            // Ten seconds on is inside the 30-second window, a minute on is not: two new listens, beside the one already there.
            expect((await rows(A)).filter((r) => r.kept_title === "Lost")).toHaveLength(3);
        } finally {
            await prisma.play.deleteMany({ where: { id: { in: ids } } });
        }
    });

    it("fold a kept play with the live plays of its song when they sit inside one listen", async () => {
        const live = play(A, "s2", ago(2 * DAY - 10 * SECOND));
        await prisma.play.create({ data: live });
        try {
            expect((await perSong(A)).get(id("s2"))).toBe(2);
        } finally {
            await prisma.play.delete({ where: { id: live.id } });
        }
    });

    it("keep the listens inside the period", async () => {
        const counts = await perSong(A, { period: "30d" });
        expect(counts.has(id("s3"))).toBe(false);
        expect(counts.get(id("s1"))).toBe(5);
    });

    it("name one song with trackId, its kept plays included, and only a library song", async () => {
        expect((await perSong(A, { trackId: id("s2") })).get(id("s2"))).toBe(2);
        expect([...(await perSong(A, { trackId: id("s1") })).keys()]).toEqual([id("s1")]);
        expect(await rows(A, { trackId: id("d1") })).toEqual([]);
    });

    it("start at since: only the listens that began then or later", async () => {
        const counts = await perSong(A, { since: ago(4 * DAY - HOUR) });
        // s1's listens 1, 2 and 3 days back; s2's kept plays at 2 and 3 days; s5's lately.
        expect(counts.get(id("s1"))).toBe(3);
        expect(counts.get(id("s2"))).toBe(2);
        expect(counts.get(id("s5"))).toBe(1);
        expect(counts.has(id("s3"))).toBe(false);
    });
});

describe("Discover listens", () => {
    it("are asked for by name: only the listens of songs on a Discover album, this person's own, no kept plays", async () => {
        const a = await rows(A, { discover: true });
        expect(a.map((r) => r.fkey)).toEqual([id("d1")]);
        expect((await rows(B, { discover: true })).map((r) => r.fkey)).toEqual([id("d1")]);
        expect(a.every((r) => r.kept_title === null)).toBe(true);
    });

    it("count a song on whichever album it is: the player bar's count of a library song and of a Discover song", async () => {
        expect(await trackPlayCount(A, id("s1"))).toBe(5);
        expect(await trackPlayCount(A, id("s2"))).toBe(2);
        expect(await trackPlayCount(A, id("d1"))).toBe(1);
        expect(await trackPlayCount(B, id("s1"))).toBe(0);
        expect(await trackPlayCount(A, id("nothing"))).toBe(0);
    });
});

describe("listened to, or never", () => {
    const pick = async (where: Prisma.Sql) =>
        (await prisma.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Track" t WHERE t.id LIKE ${P + "%"} AND ${where} ORDER BY t.id`).map((r) => r.id);

    it("is per person: A listened to a song B did not, and B to one A did not", async () => {
        const a = await pick(hasListenedSql(A));
        expect(a).toContain(id("s1"));
        expect(a).not.toContain(id("w2"));
        expect(await pick(hasListenedSql(B))).toEqual([id("s4"), id("w2")]);
    });

    it("counts a kept play toward the song it is found by", async () => {
        expect(await pick(hasListenedSql(A))).toEqual(expect.arrayContaining([id("s2"), id("s6")]));
    });

    it("never counts a Discover song as listened to", async () => {
        expect(await pick(hasListenedSql(A))).not.toContain(id("d1"));
        expect(await pick(neverListenedSql(A))).toContain(id("d1"));
    });

    it("is never exactly when it is not has", async () => {
        const has = await pick(hasListenedSql(A));
        const never = await pick(neverListenedSql(A));
        expect([...has, ...never].sort()).toEqual(SONGS.map(([s]) => id(s)).sort());
        expect(never).toContain(id("w2"));
    });

    it("takes the song's alias and refuses a name that is not one", async () => {
        const named = await prisma.$queryRaw<{ id: string }[]>`
            SELECT song.id FROM "Track" song WHERE song.id LIKE ${P + "%"} AND ${hasListenedSql(B, "song")} ORDER BY song.id`;
        expect(named.map((r) => r.id)).toEqual([id("s4"), id("w2")]);
        expect(() => neverListenedSql(A, "t; DROP TABLE x")).toThrow();
        expect(() => hasListenedSql(A, "t; DROP TABLE x")).toThrow();
    });

    it("listened to more than n times counts listens, kept plays included, never rows", async () => {
        const over = (user: string, count: number) => pick(Prisma.sql`t.id IN (${listenedMoreThanSql(user, count)})`);
        expect(await over(A, 4)).toEqual([id("s1")]);
        expect(await over(A, 1)).toEqual([id("s1"), id("s2"), id("s5"), id("w1")]);
        expect(await over(B, 0)).toEqual([id("s4"), id("w2")]);
    });
});

describe("listen counts", () => {
    const playable = playableSongSql("t", "al");

    it("is per song, counting listens, most first and then the most recently listened", async () => {
        const counts = await listenCounts(A, { song: playable });
        expect(counts.map((c) => [c.trackId, c.listens]).slice(0, 4)).toEqual([
            [id("s1"), 5], [id("s5"), 2], [id("s2"), 2], [id("w1"), 2],
        ]);
    });

    it("lets through only the songs the rule given does: Discover, missing and corrupt songs are not offered", async () => {
        const ids = (await listenCounts(A, { song: playable })).map((c) => c.trackId);
        for (const gone of ["d1", "m1", "c1"]) expect(ids).not.toContain(id(gone));
        const all = (await listenCounts(A, { song: Prisma.sql`TRUE` })).map((c) => c.trackId);
        expect(all).toEqual(expect.arrayContaining([id("m1"), id("c1")]));
        expect(all).not.toContain(id("d1"));
    });

    it("goes back only as far as since, stops at take, and keeps only the sources asked for", async () => {
        expect((await listenCounts(A, { song: playable, since: ago(7 * DAY) })).map((c) => c.trackId)).not.toContain(id("s3"));
        expect(await listenCounts(A, { song: playable, take: 2 })).toHaveLength(2);
        expect((await listenCounts(A, { song: playable, sources: ["SUBSONIC"] })).map((c) => c.trackId)).toEqual([id("s4")]);
    });

    it("counts only this person", async () => {
        expect((await listenCounts(B, { song: playable })).map((c) => [c.trackId, c.listens]).sort()).toEqual([[id("s4"), 1], [id("w2"), 2]]);
    });
});

describe("the artists of listens", () => {
    const playable = playableSongSql("t", "al");

    it("is one artist per listen, newest first, so an artist listened to often appears often", async () => {
        // Newest three of A's playable listens: s5 (1h), the Subsonic s4 (5h), the kept play of s6 (6h).
        expect((await listenedArtists(A, { song: playable, take: 3 })).map((a) => a.id)).toEqual([id("art_y"), id("art_x"), id("art_y")]);
    });

    it("leaves out Discover, missing and corrupt songs, counts repeats once, and goes back only as far as since", async () => {
        const all = await listenedArtists(A, { song: playable });
        expect(all.map((a) => a.id)).not.toContain(id("art_z"));
        // s1 x5, s2 x2, s3, s4, s5 x2, s6, w1 x2, v1: c1 and m1 stay out, and so does the kept play with no song.
        expect(all).toHaveLength(15);
        expect(await listenedArtists(A, { song: playable, since: ago(2 * HOUR) })).toHaveLength(1);
    });

    it("is this person's own", async () => {
        expect((await listenedArtists(B, { song: playable })).map((a) => a.id)).toEqual([id("art_x"), id("art_w"), id("art_w")]);
    });
});

describe("artists of recent listens", () => {
    it("is one artist once, by their newest listen, newest first, and never a Discover artist", async () => {
        const result = await recentListenArtists(A, { take: 10 });
        expect(result.map((r) => r.artistId)).not.toContain(id("art_z"));
        expect(result[0].artistId).toBe(id("art_y"));
        expect(new Set(result.map((r) => r.artistId)).size).toBe(result.length);
    });

    it("counts a kept play toward the song it is found by", async () => {
        const result = await recentListenArtists(A, { take: 1, where: Prisma.sql`t.id = ${id("s6")}` });
        expect(result.map((r) => r.artistId)).toEqual([id("art_y")]);
        expect(Math.abs(result[0].lastListenedAt.getTime() - ago(6 * HOUR).getTime())).toBeLessThan(5000);
    });

    it("answers the same from the recent walk and from the whole history", async () => {
        // take 1 is filled from the last weeks alone; take 8 needs s3 forty days back, so the whole history is walked.
        const recent = await recentListenArtists(A, { take: 1 });
        const whole = await recentListenArtists(A, { take: 8 });
        expect(whole[0]).toEqual(recent[0]);
    });

    it("refuses a take that is not a whole number", async () => {
        await expect(recentListenArtists(A, { take: 1.5 })).rejects.toThrow();
    });
});

describe("albums listened to at least", () => {
    it("holds the albums one person listened to at least that many times over at least that many songs", async () => {
        const albums = [id("alb_w"), id("alb_v"), id("alb_x")];
        expect([...(await albumsListenedAtLeast(albums, { listens: 2, songs: 1 }))].sort()).toEqual([id("alb_w"), id("alb_x")]);
        expect([...(await albumsListenedAtLeast(albums, { listens: 3, songs: 2 }))].sort()).toEqual([id("alb_x")]);
    });

    it("never adds two people's listens together: W has four listens over two songs, none from one person", async () => {
        expect([...(await albumsListenedAtLeast([id("alb_w")], { listens: 4, songs: 2 }))]).toEqual([]);
        expect([...(await albumsListenedAtLeast([id("alb_w")], { listens: 2, songs: 2 }))]).toEqual([]);
    });

    it("counts listens, not rows: ten seconds apart on V is one", async () => {
        expect([...(await albumsListenedAtLeast([id("alb_v")], { listens: 2, songs: 1 }))]).toEqual([]);
        expect([...(await albumsListenedAtLeast([id("alb_v")], { listens: 1, songs: 1 }))]).toEqual([id("alb_v")]);
    });

    it("knows nothing of a Discover album, and looks only at the albums it is given", async () => {
        expect([...(await albumsListenedAtLeast([id("alb_z")], { listens: 1, songs: 1 }))]).toEqual([]);
        expect(await albumsListenedAtLeast([], { listens: 1, songs: 1 })).toEqual(new Set());
    });
});
