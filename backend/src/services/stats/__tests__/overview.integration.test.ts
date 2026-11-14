/**
 * The stats overview, asked of one seeded history on the suite database: the listening section and the signature
 * section, each over all time and over the last 30 days. The figures are worked out by hand from the seed, so the way
 * the sections read the listens can change under them.
 *
 * A request folds the plays into listens once, however many sections and figures it shows (the fold is the costly
 * part of the page: it is a recursive walk over every play, and it was run once per figure). The route's own count is
 * in routes/__tests__/statsOverview.route.test.ts; here each section is handed one fold, as the route does.
 */
import { prisma } from "../../../utils/db";
import { hourDetail, listeningStats, regionDetail } from "../listening";
import { withListens, type Period } from "../listens";
import { signature } from "../signature";

jest.setTimeout(60_000);

const P = "ov_";
const A = `${P}a`;
const B = `${P}b`;
const id = (s: string) => `${P}${s}`;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

let n = 0;
const play = (user: string, song: string, playedAt: Date, source: "LIBRARY" | "SUBSONIC" = "LIBRARY") =>
    ({ id: `${P}play_${n++}`, userId: user, trackId: id(song), playedAt, source });

beforeAll(async () => {
    await cleanup();
    for (const u of [A, B]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    for (const [a, year] of [["x", 2010], ["y", 1995]] as const) {
        await prisma.artist.create({
            data: { id: id(`art_${a}`), name: `Overview ${a}`, normalizedName: `overview ${a}`, identityKey: id(`ak_${a}`) },
        });
        await prisma.album.create({
            data: {
                id: id(`alb_${a}`), rgMbid: id(`rg_${a}`), artistId: id(`art_${a}`), identityKey: id(`ik_${a}`),
                title: `Overview Album ${a}`, primaryType: "Album", year,
            },
        });
    }
    // Every song is 200 seconds long, so a play within 200 seconds of its listen's start is part of that listen.
    for (const [s, album, key, scale] of [
        ["s1", "alb_x", "C", "major"],
        ["s2", "alb_x", "A", "minor"],
        ["s3", "alb_y", "C", "major"],
    ] as const) {
        await prisma.track.create({
            data: {
                id: id(s), albumId: id(album), title: s, trackNo: 1, duration: 200, filePath: `/tmp/${P}${s}.flac`,
                fileModified: new Date(), fileSize: 1000, energy: 0.5, valence: 0.5, bpm: 120, key, keyScale: scale,
            },
        });
    }
    const burst = ago(7 * DAY);
    await prisma.play.createMany({
        data: [
            // s1: four listens. The row a minute after the first is the same listen; the last is long ago.
            play(A, "s1", ago(1 * DAY)),
            play(A, "s1", new Date(ago(1 * DAY).getTime() + 60_000)),
            play(A, "s1", ago(2 * DAY)),
            play(A, "s1", ago(3 * DAY)),
            play(A, "s1", ago(300 * DAY)),
            // s2: four listens. The three rows at 0, 100 and 250 seconds are two listens (the third is past 200
            // seconds from the first); one of the others comes from a Subsonic client.
            play(A, "s2", ago(5 * DAY), "SUBSONIC"),
            play(A, "s2", ago(6 * DAY)),
            play(A, "s2", burst),
            play(A, "s2", new Date(burst.getTime() + 100_000)),
            play(A, "s2", new Date(burst.getTime() + 250_000)),
            // s3: two listens, one of them over a year ago.
            play(A, "s3", ago(10 * DAY)),
            play(A, "s3", ago(400 * DAY)),
            // Somebody else's plays are nobody's business here.
            play(B, "s3", ago(1 * DAY)),
            play(B, "s3", ago(2 * DAY)),
        ],
    });
});

afterAll(async () => {
    await cleanup();
});

/** The two sections as the stats route reads them: one fold, handed to each. */
const listening = (user: string, tz: string, period: Period = "all") =>
    withListens(user, period, (l) => listeningStats(l, tz));
const signatureOf = (user: string, tz: string, period: Period = "all") =>
    withListens(user, period, (l) => signature(l, tz));

/**
 * How many times the plays were folded into listens: the fold is the one statement with a recursive walk, on the
 * client or inside a transaction. Counted at the database client, so it holds however the sections are built.
 */
let folds = 0;
const textOf = (q: unknown): string => {
    const sql = (q as { sql?: unknown } | null)?.sql;
    return typeof sql === "string" ? sql : Array.isArray(q) ? q.join("") : "";
};
const seen = (q: unknown) => {
    if (/WITH RECURSIVE/i.test(textOf(q))) folds++;
};

beforeEach(() => {
    folds = 0;
    // A transaction's client reaches these through the same object, so wrapping them here sees its statements too;
    // `this` is passed on, or a statement meant for the transaction's connection would run on another one.
    const client = prisma as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const method of ["$queryRaw", "$executeRaw"] as const) {
        const real = client[method];
        jest.spyOn(client, method).mockImplementation(function (this: unknown, ...a: unknown[]) {
            seen(a[0]);
            return real.apply(this, a);
        });
    }
});
afterEach(() => jest.restoreAllMocks());

describe("listening section", () => {
    it("counts the listens of all time", async () => {
        const L = await listening(A, "UTC");
        expect(L.plays).toBe(10);
        expect(L.estimatedSeconds).toBe(2000);
        expect(L.distinctTracks).toBe(3);
        expect(L.distinctArtists).toBe(2);
        expect(L.distinctAlbums).toBe(2);
        expect(L.bySource).toEqual({ LIBRARY: 9, SUBSONIC: 1 });
        expect(L.clock.flat().reduce((a, b) => a + b, 0)).toBe(10);
        expect(L.shape).toEqual([{ x: 13, y: 13, plays: 10 }]);
        expect(L.topArtists.map((a) => [a.name, a.plays])).toEqual([["Overview x", 8], ["Overview y", 2]]);
        expect(L.topTracks.map((t) => [t.id, t.plays]).sort()).toEqual([[id("s1"), 4], [id("s2"), 4], [id("s3"), 2]]);
        expect(L.drift.reduce((a, d) => a + d.plays, 0)).toBe(10);
    });

    it("counts the listens that began in the last 30 days", async () => {
        const L = await listening(A, "UTC", "30d");
        expect(L.plays).toBe(8);
        expect(L.distinctTracks).toBe(3);
        expect(L.distinctArtists).toBe(2);
        expect(L.bySource).toEqual({ LIBRARY: 7, SUBSONIC: 1 });
        expect(L.topTracks.map((t) => [t.id, t.plays]).sort()).toEqual([[id("s1"), 3], [id("s2"), 4], [id("s3"), 1]]);
    });

    it("counts nothing for a listener with no plays", async () => {
        const L = await listening(`${P}nobody`, "UTC");
        expect(L.plays).toBe(0);
        expect(L.topTracks).toEqual([]);
        expect(L.firstPlay).toBeNull();
    });

    it("folds the plays into listens once, however many figures it shows", async () => {
        await listening(A, "UTC");
        expect(folds).toBe(1);
    });
});

describe("signature section", () => {
    it("reads concentration, key and era from the listens of all time", async () => {
        const S = await signatureOf(A, "UTC");
        expect(S.concentration).toEqual({ forHalf: 2, forEighty: 2, distinct: 3 });
        expect(S.key?.minorPct).toBe(40);
        expect(S.key?.top[0]).toEqual({ key: "C major", plays: 6 });
        expect(S.era?.medianYear).toBe(2010);
        expect(S.era?.buckets.map((b) => [b.label, b.plays])).toEqual([["2000 to 2014", 8], ["before 2000", 2]]);
        expect(S.hourly.reduce((a, h) => a + h.plays, 0)).toBe(10);
    });

    it("reads the last 30 days", async () => {
        const S = await signatureOf(A, "UTC", "30d");
        expect(S.concentration).toEqual({ forHalf: 1, forEighty: 2, distinct: 3 });
        expect(S.key?.top[0]).toEqual({ key: "A minor", plays: 4 });
        expect(S.era?.buckets.map((b) => [b.label, b.plays])).toEqual([["2000 to 2014", 7], ["before 2000", 1]]);
    });

    it("folds the plays into listens once, however many figures it shows", async () => {
        await signatureOf(A, "UTC");
        expect(folds).toBe(1);
    });
});

/** The cell of the week grid one single listen falls in: the s1 play two days ago, alone on its weekday. */
const cell = () => {
    const at = ago(2 * DAY);
    return { dow: at.getUTCDay(), hour: at.getUTCHours() };
};

describe("hour detail", () => {
    it("lists the listens of one cell of the week", async () => {
        const { dow, hour } = cell();
        const H = await hourDetail(A, dow, hour, "UTC");
        expect(H.listens).toBe(1);
        expect(H.tracks).toEqual([{ title: "s1", artist: "Overview x", listens: 1 }]);
        expect(H.artists).toEqual([{ name: "Overview x", listens: 1 }]);
        expect(H.lastAt).not.toBeNull();
    });

    it("answers for the same window the grid was drawn from", async () => {
        const { dow, hour } = cell();
        expect((await hourDetail(A, dow, hour, "UTC", "30d")).listens).toBe(1);
    });

    it("folds the plays into listens once, however many figures it shows", async () => {
        const { dow, hour } = cell();
        await hourDetail(A, dow, hour, "UTC");
        expect(folds).toBe(1);
    });
});

describe("region detail", () => {
    it("lists the listens around one point of the taste plot", async () => {
        const R = await regionDetail(A, 13, 13);
        expect(R.listens).toBe(10);
        expect(R.tracks.map((t) => [t.title, t.listens])).toEqual([["s1", 4], ["s2", 4], ["s3", 2]]);
        expect(R.energy).toBeCloseTo(0.5, 6);
        expect(R.valence).toBeCloseTo(0.5, 6);
        expect(R.bpm).toBeCloseTo(120, 6);
    });

    it("answers for the window, and says nothing of an empty corner", async () => {
        expect((await regionDetail(A, 13, 13, 1, "30d")).listens).toBe(8);
        const empty = await regionDetail(A, 1, 1);
        expect(empty.listens).toBe(0);
        expect(empty.tracks).toEqual([]);
        expect(empty.energy).toBeNull();
    });

    it("folds the plays into listens once, however many figures it shows", async () => {
        await regionDetail(A, 13, 13);
        expect(folds).toBe(1);
    });
});
