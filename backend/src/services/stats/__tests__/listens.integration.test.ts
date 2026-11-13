/**
 * The listens module's questions, asked of one seeded history on the suite database: ever played, played more than n
 * times, listened to more than n times, most played, the artists of recent plays, and the listen rows themselves.
 * Each keeps the meaning its first reader had: "played" counts raw Play rows (skips and repeats included), "listened"
 * counts the listens `listenRows` folds them into.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { PLAYABLE_SONG } from "../../../utils/libraryEligibility";
import {
    listenRows,
    listenedMoreThanSql,
    mostPlayedTrackIds,
    neverPlayedSql,
    playedMoreThanSql,
    recentPlayArtists,
} from "../listens";

jest.setTimeout(60_000);

const P = "lq_";
const A = `${P}a`;
const B = `${P}b`;
const id = (s: string) => `${P}${s}`;
const ago = (ms: number) => new Date(Date.now() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Songs: s1..s4 on X's library album, s5..s6 on Y's, d1 on Z's Discover album, m1 missing on X's.
const SONGS: Array<[string, string]> = [
    ["s1", "alb_x"], ["s2", "alb_x"], ["s3", "alb_x"], ["s4", "alb_x"],
    ["s5", "alb_y"], ["s6", "alb_y"], ["d1", "alb_z"], ["m1", "alb_x"],
];
const ALL = SONGS.map(([s]) => id(s)).sort();

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

let n = 0;
const play = (user: string, song: string, playedAt: Date, extra: { heard?: boolean } = {}) =>
    ({ id: `${P}play_${n++}`, userId: user, trackId: id(song), playedAt, ...extra });

beforeAll(async () => {
    await cleanup();
    for (const u of [A, B]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    for (const a of ["x", "y", "z"]) {
        await prisma.artist.create({ data: { id: id(`art_${a}`), name: `Listens ${a}`, normalizedName: `listens ${a}`, identityKey: id(`ak_${a}`) } });
        await prisma.album.create({
            data: {
                id: id(`alb_${a}`), rgMbid: id(`rg_${a}`), artistId: id(`art_${a}`), identityKey: id(`ik_${a}`),
                title: `Listens Album ${a}`, primaryType: "Album", location: a === "z" ? "DISCOVER" : "LIBRARY",
            },
        });
    }
    for (const [s, album] of SONGS) {
        await prisma.track.create({
            data: {
                id: id(s), albumId: id(album), title: s, trackNo: 1, duration: 200, filePath: `/tmp/${P}${s}.flac`,
                fileModified: new Date(), fileSize: 1000, missingSince: s === "m1" ? new Date() : null,
            },
        });
    }
    await prisma.play.createMany({
        data: [
            // A: s1 five listens, s2 four listens, s5 two rows ten seconds apart (one listen) plus a later one (two
            // listens), s3 once, one Discover play, one play of the missing song.
            ...[1, 2, 3, 4, 5].map((d) => play(A, "s1", ago(d * DAY), { heard: true })),
            ...[1, 2, 3, 4].map((d) => play(A, "s2", ago(d * DAY + HOUR), { heard: true })),
            play(A, "s5", ago(10 * DAY)),
            play(A, "s5", ago(10 * DAY - 10_000)),
            play(A, "s5", ago(HOUR)),
            play(A, "s3", ago(40 * DAY)),
            play(A, "d1", ago(2 * HOUR)),
            play(A, "m1", ago(3 * HOUR)),
            // B plays one song A never touched.
            play(B, "s4", ago(HOUR)),
        ],
    });
});

afterAll(async () => {
    await cleanup();
});

/** The seeded songs a subquery or fragment picks, sorted. */
const pick = async (where: Prisma.Sql) =>
    (await prisma.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Track" t WHERE t.id LIKE ${P + "%"} AND ${where} ORDER BY t.id`).map((r) => r.id);

describe("ever played", () => {
    it("neverPlayedSql keeps the songs this listener has no Play row for, Discover and missing ones included", async () => {
        expect(await pick(neverPlayedSql(A))).toEqual([id("s4"), id("s6")]);
    });

    it("is per listener: B played only s4", async () => {
        expect(await pick(neverPlayedSql(B))).toEqual(ALL.filter((s) => s !== id("s4")));
    });

    it("takes the song's alias", async () => {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
            SELECT song.id FROM "Track" song WHERE song.id LIKE ${P + "%"} AND ${neverPlayedSql(A, "song")} ORDER BY song.id`;
        expect(rows.map((r) => r.id)).toEqual([id("s4"), id("s6")]);
    });

    it("refuses an alias that is not an identifier", () => {
        expect(() => neverPlayedSql(A, "t; DROP TABLE x")).toThrow();
    });
});

describe("played more than n times (raw rows)", () => {
    const over = (user: string, count: number) => pick(Prisma.sql`t.id IN (${playedMoreThanSql(user, count)})`);

    it("counts every row, so ten seconds apart is two plays", async () => {
        expect(await over(A, 1)).toEqual([id("s1"), id("s2"), id("s5")]);
    });

    it("keeps only songs above the count", async () => {
        expect(await over(A, 3)).toEqual([id("s1"), id("s2")]);
        expect(await over(A, 4)).toEqual([id("s1")]);
        expect(await over(A, 5)).toEqual([]);
    });

    it("counts only this listener", async () => {
        expect(await over(B, 0)).toEqual([id("s4")]);
    });
});

describe("listened to more than n times (counted listens)", () => {
    const over = (user: string, count: number) => pick(Prisma.sql`t.id IN (${listenedMoreThanSql(user, count)})`);

    it("folds rows within one play of the song into one listen, so s5 has two listens, not three", async () => {
        expect(await over(A, 2)).toEqual([id("s1"), id("s2")]);
        expect(await over(A, 1)).toEqual([id("s1"), id("s2"), id("s5")]);
    });

    it("counts only this listener", async () => {
        expect(await over(B, 0)).toEqual([id("s4")]);
        expect(await over(B, 1)).toEqual([]);
    });
});

describe("listen rows", () => {
    it("is one row per listen, from the song's first row", async () => {
        const rows = await prisma.$queryRaw<{ trackId: string; n: number }[]>`
            ${listenRows(A)}
            SELECT p."trackId", count(*)::int AS n FROM p GROUP BY p."trackId" ORDER BY p."trackId"`;
        expect(rows).toEqual([
            { trackId: id("d1"), n: 1 }, { trackId: id("m1"), n: 1 }, { trackId: id("s1"), n: 5 },
            { trackId: id("s2"), n: 4 }, { trackId: id("s3"), n: 1 }, { trackId: id("s5"), n: 2 },
        ]);
    });

    it("keeps the listens inside the window", async () => {
        const rows = await prisma.$queryRaw<{ trackId: string }[]>`
            ${listenRows(A, "30d")}
            SELECT DISTINCT p."trackId" FROM p ORDER BY p."trackId"`;
        expect(rows.map((r) => r.trackId)).not.toContain(id("s3"));
    });
});

describe("most played", () => {
    it("lists the song ids by play rows, most first, and only the songs the filter lets through", async () => {
        expect(await mostPlayedTrackIds(A, { song: PLAYABLE_SONG, take: 10 })).toEqual([
            id("s1"), id("s2"), id("s5"), id("s3"),
        ]);
    });

    it("stops at take", async () => {
        expect(await mostPlayedTrackIds(A, { song: PLAYABLE_SONG, take: 2 })).toEqual([id("s1"), id("s2")]);
    });

    it("counts only this listener", async () => {
        expect(await mostPlayedTrackIds(B, { song: PLAYABLE_SONG, take: 10 })).toEqual([id("s4")]);
    });

    it("applies the song filter it is given", async () => {
        const all = await mostPlayedTrackIds(A, { song: {}, take: 20 });
        expect(all).toEqual(expect.arrayContaining([id("d1"), id("m1")]));
    });
});

describe("artists of recent plays", () => {
    it("is one artist per play, newest play first, for the songs the filter lets through", async () => {
        const artists = await recentPlayArtists(A, { song: PLAYABLE_SONG, take: 3 });
        // Newest three of A's playable plays: s5 (1h), s1 (1d), s2 (1d+1h).
        expect(artists.map((a) => a.id)).toEqual([id("art_y"), id("art_x"), id("art_x")]);
        expect(artists[0].name).toBe("Listens y");
    });

    it("leaves out the Discover and missing plays under the playable rule, and a looser filter lets the missing song's play through", async () => {
        const playable = await recentPlayArtists(A, { song: PLAYABLE_SONG });
        expect(playable.map((a) => a.id)).not.toContain(id("art_z"));
        expect(playable).toHaveLength(5 + 4 + 3 + 1);
        const library = await recentPlayArtists(A, { song: { album: { location: "LIBRARY" } } });
        expect(library).toHaveLength(playable.length + 1);
    });

    it("only goes back as far as since", async () => {
        const week = await recentPlayArtists(A, { song: PLAYABLE_SONG, since: ago(7 * DAY) });
        // s1 x5 (1..5 days), s2 x4, s5 once an hour ago; the ten-day-old s5 plays and the 40-day-old s3 play are out.
        expect(week).toHaveLength(5 + 4 + 1);
    });

    it("is this listener's own", async () => {
        expect((await recentPlayArtists(B, { song: PLAYABLE_SONG })).map((a) => a.id)).toEqual([id("art_x")]);
    });
});
