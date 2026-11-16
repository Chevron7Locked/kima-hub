/**
 * What the listens module does with kept plays: the plays of songs that left the library with no copy to take them.
 * The stats page's totals are the same before and after a delete; the readers that need a song count a kept play only
 * toward a present song it is found by; the audit still sees them in order. Real database; no mocks.
 */
import { prisma } from "../../../utils/db";
import { deleteAlbums, deleteArtists, deleteSongs } from "../../library/albumDelete";
import { Prisma } from "@prisma/client";
import { playableSongSql } from "../../../utils/playableSong";
import {
    countPlaysBefore,
    listenCounts,
    listenedArtists,
    listenedMoreThanSql,
    neverListenedSql,
    playHistoryPages,
    recentListenArtists,
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

    it("give a gone artist the id of the library artist whose name folds to its own, the lowest id when several do", async () => {
        await deleteArtists([id("art_x")]);
        for (const [key, name] of [["x3", `${P}ARTIST X`], ["x2", `${P}artist  x`]] as const) {
            await prisma.artist.create({ data: { id: id(`art_${key}`), name, identityKey: id(`ak_${key}`) } });
            await prisma.album.create({
                data: { id: id(`alb_${key}`), rgMbid: id(`rg_${key}`), artistId: id(`art_${key}`), identityKey: id(`ik_${key}`), title: `${P}alb_${key}`, primaryType: "Album", location: "LIBRARY" },
            });
            await prisma.track.create({
                data: { id: id(`s_${key}`), albumId: id(`alb_${key}`), title: `${P}Song ${key}`, trackNo: 1, duration: 200, filePath: `/${P}outside/${key}.flac`, fileModified: new Date(), fileSize: 1 },
            });
        }

        const stats = await withListens(USER, "all", (l) => listeningStats(l, "UTC"));

        // The gone artist's three listens count with the lowest-id library artist that its name folds to, under that name.
        expect(stats.topArtists.find((a) => a.id === id("art_x2"))?.plays).toBe(3);
        expect(stats.topArtists.some((a) => a.id === id("art_x3"))).toBe(false);
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
    const rule = playableSongSql("t", "al");
    const never = () => prisma.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM "Track" t WHERE t.id LIKE ${P + "%"} AND ${neverListenedSql(USER)}`;

    it("leave a kept play no present song matches out of per-song counts and never see a null song", async () => {
        const counted = await listenCounts(USER, { song: Prisma.sql`TRUE` });
        // The Discover song z1 is no library listen, so it is in no count.
        expect(counted.map((c) => c.trackId).sort()).toEqual([id("x1"), id("x2"), id("y1")].sort());

        await deleteSongs([id("x1")]);

        const after = await listenCounts(USER, { song: Prisma.sql`TRUE` });
        expect(after.map((c) => c.trackId).sort()).toEqual([id("x2"), id("y1")].sort());
        const over = await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT t.id FROM "Track" t WHERE t.id LIKE ${P + "%"} AND t.id NOT IN (${listenedMoreThanSql(USER, 0)})`;
        expect(over.map((r) => r.id).sort()).toEqual([id("z1")]);
        expect((await never()).map((r) => r.id)).toEqual([id("z1")]);
    });

    it("give the kept plays back to a song with the same recording id when it returns", async () => {
        await deleteSongs([id("x1")]);
        await prisma.track.create({
            data: {
                id: id("x9"), albumId: id("alb_y"), title: `${P}Song x9`, trackNo: 5, duration: 200, filePath: `/${P}outside/x9.flac`,
                fileModified: new Date(), fileSize: 1, recordingMbid: REC,
            },
        });

        const counted = await listenCounts(USER, { song: rule });
        // Two listens: the first two rows fold into one, the Subsonic scrobble three days on is the other.
        expect(counted.find((c) => c.trackId === id("x9"))?.listens).toBe(2);
        expect((await never()).map((r) => r.id)).not.toContain(id("x9"));
    });

    it("read no artist for a kept play no present song matches", async () => {
        await deleteSongs([id("x1")]);
        const artists = await listenedArtists(USER, { song: rule });
        expect(artists.map((a) => a.id).sort()).toEqual([id("art_x"), id("art_y"), id("art_y")]);
        expect((await recentListenArtists(USER, { take: 10 })).map((a) => a.artistId).sort()).toEqual([id("art_x"), id("art_y")]);
    });

    it("count every play, kept ones included, before a moment", async () => {
        const before = await countPlaysBefore(USER, new Date());
        await deleteSongs([id("x1")]);
        expect(await countPlaysBefore(USER, new Date())).toBe(before);
    });
});

describe("the readers that find a kept play's song by its stored names", () => {
    const rule = playableSongSql("t", "al");

    /** A library song with its own artist and album, for a song that returns under other spellings of the same names. */
    async function copy(key: string, names: { artist: string; album: string; title: string }): Promise<string> {
        await prisma.artist.create({ data: { id: id(`art_${key}`), name: names.artist, identityKey: id(`ak_${key}`) } });
        await prisma.album.create({
            data: { id: id(`alb_${key}`), rgMbid: id(`rg_${key}`), artistId: id(`art_${key}`), identityKey: id(`ik_${key}`), title: names.album, primaryType: "Album", location: "LIBRARY" },
        });
        await prisma.track.create({
            data: { id: id(`s_${key}`), albumId: id(`alb_${key}`), title: names.title, trackNo: 1, duration: 200, filePath: `/${P}outside/${key}.flac`, fileModified: new Date(), fileSize: 1 },
        });
        return id(`s_${key}`);
    }
    const listensOf = async (song: string) => (await listenCounts(USER, { song: rule })).find((c) => c.trackId === song)?.listens;
    const gone = async () => {
        await deleteAlbums([id("alb_x")]);
        await deleteArtists([id("art_x")]);
    };

    it("finds the song when its names come back in another case, accent or punctuation", async () => {
        await gone();
        const song = await copy("n1", { artist: "ZZ Kept \u2014 Art\u00edst x", album: "ZZ-Kept ALB_X", title: "Zz Kept: S\u00f6ng x2" });

        expect(await listensOf(song)).toBe(1);
    });

    it("does not find a song whose names differ by more than folding", async () => {
        await gone();
        const song = await copy("n2", { artist: `${P}Another Artist`, album: `${P}alb_x`, title: `${P}Song x2` });

        expect(await listensOf(song)).toBeUndefined();
    });

    /** A compilation's song played once, then gone with its album and artist. */
    async function goneCompilation(): Promise<void> {
        await prisma.artist.create({ data: { id: id("art_va"), name: "Various Artists", identityKey: id("ak_va") } });
        await prisma.album.create({
            data: { id: id("alb_va"), rgMbid: id("rg_va"), artistId: id("art_va"), identityKey: id("ik_va"), title: `${P}Now 99`, primaryType: "Album", location: "LIBRARY" },
        });
        await prisma.track.create({
            data: { id: id("va1"), albumId: id("alb_va"), title: `${P}Hit A`, trackNo: 1, duration: 200, filePath: `/${P}outside/va1.flac`, fileModified: new Date(), fileSize: 1 },
        });
        await play("va1", new Date(Date.now() - DAY));
        await deleteAlbums([id("alb_va")]);
        await deleteArtists([id("art_va")]);
    }

    it("finds a compilation's song on the Various Artists album that comes back", async () => {
        await goneCompilation();
        const song = await copy("n3", { artist: "VARIOUS ARTISTS", album: `${P}NOW 99`, title: `${P}hit a` });

        expect(await listensOf(song)).toBe(1);
    });

    it("does not give a compilation's kept play to the same album and title under a named artist", async () => {
        await goneCompilation();
        const named = await copy("n5", { artist: `${P}Named Artist`, album: `${P}Now 99`, title: `${P}Hit A` });
        const compilation = await copy("n6", { artist: "Various Artists", album: `${P}Now 99`, title: `${P}Hit A` });

        expect(await listensOf(named)).toBeUndefined();
        expect(await listensOf(compilation)).toBe(1);
    });

    it("finds a song given an edited title after its plays were kept under the file's title", async () => {
        await gone();
        const song = await copy("n7", { artist: `${P}Artist x`, album: `${P}alb_x`, title: `${P}Song x2` });
        await prisma.track.update({ where: { id: song }, data: { displayTitle: "A Title Someone Edited" } });

        expect(await listensOf(song)).toBe(1);
    });

    it("finds a song whose file title changed since its plays were kept under its edited title", async () => {
        await prisma.track.update({ where: { id: id("x2") }, data: { displayTitle: "A Title Someone Edited" } });
        await gone();
        const song = await copy("n8", { artist: `${P}Artist x`, album: `${P}alb_x`, title: "A Different File Title" });
        await prisma.track.update({ where: { id: song }, data: { displayTitle: "a title someone EDITED" } });

        expect(await listensOf(song)).toBe(1);
    });

    it("finds a song on an album given an edited title after the plays were kept under the file's title", async () => {
        await gone();
        const song = await copy("n9", { artist: `${P}Artist x`, album: `${P}alb_x`, title: `${P}Song x2` });
        await prisma.album.update({ where: { id: id("alb_n9") }, data: { displayTitle: "An Album Someone Edited" } });

        expect(await listensOf(song)).toBe(1);
    });

    it("counts a gone song's plays under the album the library lists after that album is given an edited title", async () => {
        await deleteSongs([id("x2")]);
        const before = (await withListens(USER, "all", (l) => listeningStats(l, "UTC"))).distinctAlbums;
        await prisma.album.update({ where: { id: id("alb_x") }, data: { displayTitle: "An Album Someone Edited" } });

        // x1 and the gone x2 are one album's plays, y1 another's: two albums, not three.
        expect(before).toBe(2);
        expect((await withListens(USER, "all", (l) => listeningStats(l, "UTC"))).distinctAlbums).toBe(2);
    });

    it("does not give a single artist's kept play to the same album and title under another artist", async () => {
        await gone();
        const song = await copy("n4", { artist: `${P}Someone Else`, album: `${P}ALB_X`, title: `${P}SONG X2` });

        expect(await listensOf(song)).toBeUndefined();
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
