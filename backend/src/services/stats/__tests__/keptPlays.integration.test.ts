/**
 * What the listens module does with kept plays: the plays of songs that left the library with no copy to take them.
 * The stats page's totals are the same before and after a delete; the readers that offer songs, or need a song, leave
 * kept plays out; the audit still sees them in order. Real database; no mocks.
 */
import { prisma } from "../../../utils/db";
import { deleteAlbums, deleteArtists, deleteSongs } from "../../library/albumDelete";
import { PLAYABLE_SONG } from "../../../utils/playableSong";
import {
    countPlaysBefore,
    neverPlayedSql,
    playCounts,
    playHistoryPages,
    playedMoreThanSql,
    recentListenArtists,
    recentPlayArtists,
    withListens,
} from "../listens";
import { hourDetail, listeningStats } from "../listening";
import { signature } from "../signature";

jest.setTimeout(60_000);

const P = "zz-kept_";
const id = (s: string) => `${P}${s}`;
const USER = id("user");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REC = "33333333-3333-4333-8333-333333333333";

async function clear(): Promise<void> {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

let n = 0;
const play = (song: string, at: Date, source: "LIBRARY" | "SUBSONIC" = "LIBRARY") =>
    prisma.play.create({ data: { id: id(`p${n++}`), userId: USER, trackId: id(song), playedAt: at, source } });

async function seed(): Promise<void> {
    for (const a of ["x", "y"]) {
        await prisma.artist.create({ data: { id: id(`art_${a}`), name: `${P}Artist ${a}`, identityKey: id(`ak_${a}`) } });
    }
    for (const [alb, art, loc] of [["alb_x", "art_x", "LIBRARY"], ["alb_y", "art_y", "LIBRARY"], ["alb_z", "art_y", "DISCOVER"]] as const) {
        await prisma.album.create({
            data: { id: id(alb), rgMbid: id(`rg_${alb}`), artistId: id(art), identityKey: id(`ik_${alb}`), title: `${P}${alb}`, primaryType: "Album", location: loc, year: 2018 },
        });
    }
    const songs: Array<[string, string, string | null, number]> = [
        ["x1", "alb_x", REC, 1],
        ["x2", "alb_x", null, 2],
        ["y1", "alb_y", null, 1],
        ["z1", "alb_z", null, 1],
    ];
    for (const [s, alb, rec, no] of songs) {
        await prisma.track.create({
            data: {
                id: id(s), albumId: id(alb), title: `${P}Song ${s}`, trackNo: no, duration: 200, filePath: `/${P}outside/${s}.flac`,
                fileModified: new Date(), fileSize: 1, recordingMbid: rec, energy: 0.5, valence: 0.5, bpm: 120,
            },
        });
    }
    const base = Date.now() - 20 * DAY;
    // Two listens of x1 (a repeat 20 seconds after the first folds into it), one of x2, two of y1, one of the Discover song.
    await play("x1", new Date(base));
    await play("x1", new Date(base + 20_000));
    await play("x1", new Date(base + 3 * DAY), "SUBSONIC");
    await play("x2", new Date(base + 2 * DAY));
    await play("y1", new Date(base + 4 * DAY));
    await play("y1", new Date(base + 5 * DAY + 3 * HOUR));
    await play("z1", new Date(base + 6 * DAY));
}

const totals = () => withListens(USER, "all", async (l) => {
    const s = await listeningStats(l, "UTC");
    // Audio-feature figures read live songs only (a kept play carries none), so `shape` is left out with the top tracks.
    const { topTracks: _tracks, shape: _shape, topArtists, ...rest } = s;
    return { ...rest, topArtists: topArtists.map((a) => [a.name, a.plays, a.estimatedSeconds]) };
});

beforeAll(async () => {
    await clear();
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
});
beforeEach(seed);
afterEach(clear);
afterAll(async () => {
    await clear();
    await prisma.user.deleteMany({ where: { id: USER } });
});

describe("the stats page's totals", () => {
    it("are the same after a song is deleted with no copy", async () => {
        const before = await totals();
        expect(before.plays).toBe(5);

        await deleteSongs([id("x1")]);

        expect(await totals()).toEqual(before);
    });

    it("are the same after the album and then the artist are deleted", async () => {
        const before = await totals();

        await deleteAlbums([id("alb_x")]);
        expect(await totals()).toEqual(before);

        await deleteArtists([id("art_x")]);
        expect(await totals()).toEqual(before);
    });

    it("still name the artist and count its plays when the artist is gone and another of the same name is added", async () => {
        const before = await totals();
        await deleteArtists([id("art_x")]);
        await prisma.artist.create({ data: { id: id("art_x2"), name: `${P}Artist x`, identityKey: id("ak_x2") } });

        expect(await totals()).toEqual(before);
    });

    it("never give a gone artist the id of a same-named artist that only Discover holds", async () => {
        await deleteArtists([id("art_x")]);
        await prisma.artist.create({ data: { id: id("art_dx"), name: `${P}Artist x`, identityKey: id("ak_dx") } });
        await prisma.album.create({
            data: { id: id("alb_dx"), rgMbid: id("rg_dx"), artistId: id("art_dx"), identityKey: id("ik_dx"), title: `${P}alb_dx`, primaryType: "Album", location: "DISCOVER" },
        });

        const stats = await withListens(USER, "all", (l) => listeningStats(l, "UTC"));

        expect(stats.topArtists.find((a) => a.name === `${P}Artist x`)?.id).toBeNull();
    });

    it("give a gone artist the id of a same-named artist the library holds", async () => {
        await deleteArtists([id("art_x")]);
        await prisma.artist.create({ data: { id: id("art_x2"), name: `${P}Artist x`, identityKey: id("ak_x2") } });
        await prisma.album.create({
            data: { id: id("alb_x2"), rgMbid: id("rg_x2"), artistId: id("art_x2"), identityKey: id("ik_x2"), title: `${P}alb_x2`, primaryType: "Album", location: "LIBRARY" },
        });
        await prisma.track.create({
            data: { id: id("x9"), albumId: id("alb_x2"), title: `${P}Song x9`, trackNo: 1, duration: 200, filePath: `/${P}outside/x9.flac`, fileModified: new Date(), fileSize: 1 },
        });

        const stats = await withListens(USER, "all", (l) => listeningStats(l, "UTC"));

        expect(stats.topArtists.find((a) => a.name === `${P}Artist x`)?.id).toBe(id("art_x2"));
    });

    it("count a Discover play nowhere, kept or not", async () => {
        const before = await totals();
        await deleteAlbums([id("alb_z")]);
        expect(await totals()).toEqual(before);
    });

    it("leave the top tracks to songs that are there, and the signature still answers", async () => {
        await deleteSongs([id("x1")]);
        const { tracks, sig } = await withListens(USER, "all", async (l) => ({
            tracks: (await listeningStats(l, "UTC")).topTracks.map((t) => t.id),
            sig: await signature(l, "UTC"),
        }));
        expect(tracks).not.toContain(id("x1"));
        expect(sig.concentration?.distinct).toBe(3);
    });

    it("name a gone song and artist in the hour detail", async () => {
        const [row] = await prisma.play.findMany({ where: { trackId: id("x2") } });
        await deleteAlbums([id("alb_x")]);
        await deleteArtists([id("art_x")]);
        const hour = row.playedAt.getUTCHours();
        const detail = await hourDetail(USER, row.playedAt.getUTCDay(), hour, "UTC");
        expect(detail.tracks.map((t) => t.title)).toContain(`${P}Song x2`);
        expect(detail.artists.map((a) => a.name)).toContain(`${P}Artist x`);
    });
});

describe("the readers that need a song", () => {
    it("leave kept plays out of per-song counts and never see a null song", async () => {
        const counted = await playCounts(USER);
        expect(counted.map((c) => c.trackId).sort()).toEqual([id("x1"), id("x2"), id("y1"), id("z1")].sort());

        await deleteSongs([id("x1")]);

        const after = await playCounts(USER);
        expect(after.map((c) => c.trackId).sort()).toEqual([id("x2"), id("y1"), id("z1")].sort());
        const over = await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT t.id FROM "Track" t WHERE t.id LIKE ${P + "%"} AND t.id NOT IN (${playedMoreThanSql(USER, 0)})`;
        expect(over).toEqual([]);
        expect((await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT t.id FROM "Track" t WHERE t.id LIKE ${P + "%"} AND ${neverPlayedSql(USER)}`)).toEqual([]);
    });

    it("read no artist for a kept play", async () => {
        await deleteSongs([id("x1")]);
        const artists = await recentPlayArtists(USER, { song: PLAYABLE_SONG });
        expect(artists.map((a) => a.id).sort()).toEqual([id("art_x"), id("art_y"), id("art_y")]);
        expect((await recentListenArtists(USER, { take: 10 })).map((a) => a.artistId).sort()).toEqual([id("art_x"), id("art_y")]);
    });

    it("count every play, kept ones included, before a moment", async () => {
        const before = await countPlaysBefore(USER, new Date());
        await deleteSongs([id("x1")]);
        expect(await countPlaysBefore(USER, new Date())).toBe(before);
    });
});

describe("the play-history audit's pages", () => {
    it("carry kept plays in order, as plays that are not library plays", async () => {
        await deleteSongs([id("x1")]);

        const rows = [];
        for await (const page of playHistoryPages(USER)) rows.push(...page);

        expect(rows).toHaveLength(7);
        const orphans = rows.filter((r) => r.trackId === null);
        expect(orphans).toHaveLength(3);
        expect(orphans.every((r) => r.library === false)).toBe(true);
        expect(rows.map((r) => r.playedAt.getTime())).toEqual([...rows.map((r) => r.playedAt.getTime())].sort((a, b) => a - b));
    });
});
