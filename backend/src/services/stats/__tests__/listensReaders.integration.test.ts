/**
 * The listens module's questions that read raw play rows on purpose: the play-history audit's pages, plays before a
 * moment, a play between two moments (history repair), and who played these songs (an existence check for the
 * library's deletes). Every count lives in `listenCounting.integration.test.ts`. Real suite database.
 */
import { ListenSource } from "@prisma/client";
import { prisma } from "../../../utils/db";
import {
    countPlaysBefore,
    hasPlayBetween,
    listenersOf,
    playHistoryPages,
} from "../listens";

jest.setTimeout(60_000);

const P = "lr_";
const A = `${P}a`;
const B = `${P}b`;
const id = (s: string) => `${P}${s}`;
const ago = (ms: number) => new Date(Date.now() - ms);
const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Songs: p1..p3 on artist p's library album, q1 on q's Discover album, r1..r2 on r's library album.
const SONGS: Array<[string, string]> = [
    ["p1", "alb_p"], ["p2", "alb_p"], ["p3", "alb_p"], ["q1", "alb_q"], ["r1", "alb_r"], ["r2", "alb_r"],
];

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

let n = 0;
const play = (user: string, song: string, playedAt: Date, extra: { heard?: boolean; source?: ListenSource } = {}) =>
    ({ id: `${P}play_${String(n++).padStart(3, "0")}`, userId: user, trackId: id(song), playedAt, ...extra });

beforeAll(async () => {
    await cleanup();
    for (const u of [A, B]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    for (const a of ["p", "q", "r"]) {
        await prisma.artist.create({ data: { id: id(`art_${a}`), name: `Readers ${a}`, normalizedName: `readers ${a}`, identityKey: id(`ak_${a}`) } });
        await prisma.album.create({
            data: {
                id: id(`alb_${a}`), rgMbid: id(`rg_${a}`), artistId: id(`art_${a}`), identityKey: id(`ik_${a}`),
                title: `Readers Album ${a}`, primaryType: "Album", location: a === "q" ? "DISCOVER" : "LIBRARY",
            },
        });
    }
    for (const [s, album] of SONGS) {
        await prisma.track.create({
            data: {
                id: id(s), albumId: id(album), title: s, trackNo: 1, duration: 200, filePath: `/tmp/${P}${s}.flac`,
                fileModified: new Date(), fileSize: 1000,
            },
        });
    }
    await prisma.play.createMany({
        data: [
            // A: p1 three listens on three days (heard), p2 two rows ten seconds apart (one listen), a Discover play,
            // a Subsonic scrobble, an old library play of r2.
            play(A, "p1", ago(3 * DAY), { heard: true }),
            play(A, "p1", ago(2 * DAY), { heard: true }),
            play(A, "p1", ago(1 * DAY), { heard: true }),
            play(A, "p2", ago(6 * HOUR)),
            play(A, "p2", ago(6 * HOUR - 10 * SECOND)),
            play(A, "q1", ago(1 * HOUR)),
            play(A, "r1", ago(2 * HOUR), { source: "SUBSONIC" }),
            play(A, "r2", ago(30 * DAY), { heard: true }),
            // B: one play of p1 and of q1.
            play(B, "p1", ago(HOUR)),
            play(B, "q1", ago(2 * HOUR)),
        ],
    });
});

afterAll(async () => {
    await cleanup();
});

/** The whole history, read in pages of the given size. */
async function playHistory(user: string, pageSize?: number) {
    const rows = [];
    for await (const page of playHistoryPages(user, { pageSize })) rows.push(...page);
    return rows;
}

describe("play history", () => {
    it("is every row of this listener's, oldest first, with the song's title, length and artist", async () => {
        const rows = await playHistory(A);
        expect(rows).toHaveLength(8);
        expect(rows.map((r) => r.playedAt.getTime())).toEqual([...rows.map((r) => r.playedAt.getTime())].sort((x, y) => x - y));
        expect(rows[0]).toMatchObject({
            trackId: id("r2"), heard: true,
            track: { title: "r2", displayTitle: null, duration: 200, album: { artist: { name: "Readers r", displayName: null } } },
        });
    });

    it("keeps the plays of Discover songs, and says which songs are on a library album", async () => {
        const all = await playHistory(A);
        expect(all.find((r) => r.trackId === id("q1"))?.library).toBe(false); // alb_q is the Discover album
        expect(all.find((r) => r.trackId === id("p1"))?.library).toBe(true);
    });

    it("reads the same rows whatever the page size, with a page boundary inside a tie", async () => {
        const at = ago(41 * DAY);
        await prisma.play.createMany({
            data: ["a", "b", "c", "d", "e"].map((x) => ({ id: `${P}pg_${x}`, userId: B, trackId: id("p3"), playedAt: at })),
        });
        const whole = await playHistory(B);
        for (const size of [1, 2, 3]) expect((await playHistory(B, size)).map((r) => r.id)).toEqual(whole.map((r) => r.id));
        expect(whole.filter((r) => r.id.startsWith(`${P}pg_`)).map((r) => r.id)).toEqual(["a", "b", "c", "d", "e"].map((x) => `${P}pg_${x}`));
        await prisma.play.deleteMany({ where: { id: { startsWith: `${P}pg_` } } });
    });

    it("breaks a tie on the row id", async () => {
        const at = ago(40 * DAY);
        await prisma.play.createMany({ data: [{ id: `${P}tie_b`, userId: B, trackId: id("p3"), playedAt: at }, { id: `${P}tie_a`, userId: B, trackId: id("p3"), playedAt: at }] });
        const rows = (await playHistory(B)).filter((r) => r.trackId === id("p3"));
        expect(rows.map((r) => r.id)).toEqual([`${P}tie_a`, `${P}tie_b`]);
        await prisma.play.deleteMany({ where: { id: { startsWith: `${P}tie_` } } });
    });
});

describe("plays before a moment", () => {
    it("counts this listener's rows before it, and none after", async () => {
        expect(await countPlaysBefore(A, ago(12 * HOUR))).toBe(4);
        expect(await countPlaysBefore(A, new Date())).toBe(8);
        expect(await countPlaysBefore(B, ago(90 * 60_000))).toBe(1);
    });
});

describe("a play between two moments", () => {
    const around = (db: Parameters<typeof hasPlayBetween>[0], at: Date, windowMs: number) =>
        hasPlayBetween(db, { userId: A, trackId: id("p1"), after: new Date(at.getTime() - windowMs), before: new Date(at.getTime() + windowMs) });

    it("is true when a row of that song by that listener sits strictly inside", async () => {
        expect(await around(prisma, ago(2 * DAY - 1000), 5000)).toBe(true);
    });

    it("is false when the row sits exactly on a bound, or belongs to another song or listener", async () => {
        const t = ago(2 * DAY);
        const row = await prisma.play.findFirstOrThrow({ where: { userId: A, trackId: id("p1"), playedAt: { gt: new Date(t.getTime() - 5000), lt: new Date(t.getTime() + 5000) } } });
        const on = row.playedAt.getTime();
        expect(await hasPlayBetween(prisma, { userId: A, trackId: id("p1"), after: new Date(on), before: new Date(on + 5000) })).toBe(false);
        expect(await hasPlayBetween(prisma, { userId: A, trackId: id("p1"), after: new Date(on - 5000), before: new Date(on) })).toBe(false);
        expect(await hasPlayBetween(prisma, { userId: A, trackId: id("p3"), after: new Date(on - 5000), before: new Date(on + 5000) })).toBe(false);
        expect(await hasPlayBetween(prisma, { userId: B, trackId: id("p1"), after: new Date(on - 5000), before: new Date(on + 5000) })).toBe(false);
    });

    it("reads through a transaction", async () => {
        const found = await prisma.$transaction((tx) => around(tx, ago(2 * DAY - 1000), 5000));
        expect(found).toBe(true);
    });
});

describe("who played these songs", () => {
    it("is each listener once per song, by listener and then song, whatever the number of plays", async () => {
        expect(await listenersOf(prisma, [id("q1"), id("p1"), id("p2")])).toEqual([
            { userId: A, trackId: id("p1") },
            { userId: A, trackId: id("p2") },
            { userId: A, trackId: id("q1") },
            { userId: B, trackId: id("p1") },
            { userId: B, trackId: id("q1") },
        ]);
    });

    it("leaves out songs nobody played, and answers nothing for no songs", async () => {
        expect(await listenersOf(prisma, [id("p3")])).toEqual([]);
        expect(await listenersOf(prisma, [])).toEqual([]);
    });

    it("reads through a transaction, and takes a list longer than a statement's bind parameters", async () => {
        const many = [id("r1"), ...Array.from({ length: 40_000 }, (_, i) => `${P}nosuch${i}`)];
        expect(await prisma.$transaction((tx) => listenersOf(tx, many))).toEqual([{ userId: A, trackId: id("r1") }]);
    });
});
