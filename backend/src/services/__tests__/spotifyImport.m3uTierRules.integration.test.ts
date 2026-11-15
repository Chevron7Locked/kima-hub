/**
 * Three rules of the M3U import that playlist apps and Navidrome share. Through `importFromM3U`, on the suite DB.
 *
 * - Tier 2 (the file name): when the entry names both an artist and a title, both must agree with the song; one agreeing
 *   field is enough only when the entry has only that field. A miss can still match at tiers 3 and 4.
 * - A file name that more than one library song answers to is skipped, not given to the lowest id: the song sharing the
 *   most trailing path with the entry wins, and equally long hits are skipped (a bare name is a path of one segment).
 * - Tier 4 breaks a score tie by the exact artist, then the lowest id.
 * - When no entry matches, no playlist is made, the owner gets an "import failed" notification, and the import throws
 *   M3UNothingMatched.
 */
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../artistIdentity";
import { spotifyImportService } from "../spotifyImport";
import { M3UNothingMatched, type M3UEntry } from "../m3uParser";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-m3u-rules";
const USER = `${P}-user`;

async function cleanup() {
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: artistIdentityKey(P) } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: "zzquartz" } } });
}

/** One artist and album holding the songs given as [id suffix, title, file path stored relative to the music folder]. */
async function seedSongs(key: string, artistName: string, songs: [string, string, string][]) {
    const artist = await prisma.artist.create({ data: { name: artistName, normalizedName: artistName.toLowerCase(), identityKey: artistIdentityKey(artistName) } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}-album`, primaryType: "Album", title: `${P} ${key} album`, artistId: artist.id, location: "LIBRARY" },
    });
    for (const [n, [suffix, title, filePath]] of songs.entries()) {
        await prisma.track.create({
            data: { id: `${P}-${key}-${suffix}`, title, albumId: album.id, trackNo: n + 1, duration: 100, filePath, fileModified: new Date(), fileSize: 1 },
        });
    }
}

const entry = (filePath: string, artist: string | null = null, title: string | null = null): M3UEntry => ({ filePath, durationSeconds: null, artist, title });
let count = 0;
const matches = async (entries: M3UEntry[]) => {
    const { playlistId } = await spotifyImportService.importFromM3U(USER, `${P}-m3u-${++count}`, entries);
    const items = await prisma.playlistItem.findMany({ where: { playlistId }, orderBy: { sort: "asc" } });
    return items.map((i) => i.trackId);
};
/** The one song a lone entry matched, or null when it matched none (which the import answers by throwing). */
const match = async (e: M3UEntry) => {
    try {
        return (await matches([e]))[0] ?? null;
    } catch (error) {
        if (error instanceof M3UNothingMatched) return null;
        throw error;
    }
};

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("tier 2 needs the artist and the title to agree when the entry names both", () => {
    const ARTIST = `${P}-both band`;
    const TITLE = `${P} both real title`;
    beforeAll(() => seedSongs("both", ARTIST, [["a-real", TITLE, `${P}/both/album/zzboth song.flac`]]));

    it("accepts a file whose artist and title both agree", async () => {
        expect(await match(entry("/elsewhere/zzboth song.flac", ARTIST, TITLE))).toBe(`${P}-both-a-real`);
    });

    it("refuses a file whose artist agrees and whose title does not, and the other way round", async () => {
        expect(await match(entry("/elsewhere/zzboth song.flac", ARTIST, "a title that disagrees"))).toBeNull();
        expect(await match(entry("/elsewhere/zzboth song.flac", "somebody else entirely", TITLE))).toBeNull();
    });

    it("accepts one agreeing field when the entry has only that field", async () => {
        expect(await match(entry("/elsewhere/zzboth song.flac", ARTIST, null))).toBe(`${P}-both-a-real`);
        expect(await match(entry("/elsewhere/zzboth song.flac", null, TITLE))).toBe(`${P}-both-a-real`);
    });

    it("a refused file name still matches at the metadata tiers", async () => {
        // A namesake file by another artist with the same title (and the lowest id): it agrees on the title alone.
        await seedSongs("miss", `${P}-miss other band`, [["a-decoy", `${P} miss title`, `${P}/miss/decoy/zzmiss song.flac`]]);
        await seedSongs("miss-real", `${P}-miss real band`, [["b-real", `${P} miss title`, `${P}/miss/real/another name.flac`]]);
        expect(await match(entry("/elsewhere/zzmiss song.flac", `${P}-miss real band`, `${P} miss title`))).toBe(`${P}-miss-real-b-real`);
    });
});

describe("a bare file name that more than one song answers to is skipped", () => {
    beforeAll(async () => {
        await seedSongs("dup", `${P}-dup band`, [
            ["a-first", `${P} dup first`, `${P}/dup/one/zzdup song.flac`],
            ["b-second", `${P} dup second`, `${P}/dup/two/zzdup song.flac`],
        ]);
        await seedSongs("twin", `${P}-twin band`, [
            ["a-first", `${P} twin title`, `${P}/twin/one/zztwin song.flac`],
            ["b-second", `${P} twin title`, `${P}/twin/two/zztwin song.flac`],
        ]);
        await seedSongs("solo", `${P}-solo band`, [["a-only", `${P} solo only`, `${P}/solo/album/zzsolo song.flac`]]);
    });

    it("counts it as unmatched, in a list with other entries too", async () => {
        const entries = [entry("zzdup song.flac"), entry("zzsolo song.flac")];
        expect(await matches(entries)).toEqual([`${P}-solo-a-only`]);
        const { unmatched } = await spotifyImportService.importFromM3U(USER, `${P}-m3u-${++count}`, entries);
        expect(unmatched).toBe(1);
    });

    it("is skipped in whatever letter case, and the metadata tiers do not pick a song for it either", async () => {
        expect(await match(entry("ZZDUP SONG.FLAC"))).toBeNull();
        expect(await match(entry("zztwin song.flac", `${P}-twin band`, `${P} twin title`))).toBeNull();
    });

    it("an entry whose artist or title singles out one of the songs still finds it", async () => {
        expect(await match(entry("zzdup song.flac", `${P}-dup band`, `${P} dup second`))).toBe(`${P}-dup-b-second`);
    });

    it("still matches a bare name only one song answers to", async () => {
        expect(await match(entry("zzsolo song.flac"))).toBe(`${P}-solo-a-only`);
    });

    it("skips a name whose folders in front of it match no song better than the others", async () => {
        expect(await match(entry("/elsewhere/zzdup song.flac"))).toBeNull();
    });
});

describe("tier 2 matches the longest trailing path, as Navidrome does", () => {
    beforeAll(() =>
        seedSongs("suf", `${P}-suf band`, [
            ["a", `${P} suf first`, `${P}/suf/zzsufA/Disc1/zzsuf song.flac`],
            ["b", `${P} suf second`, `${P}/suf/zzsufB/Disc1/zzsuf song.flac`],
            ["c", `${P} suf third`, `${P}/suf/zzsufB/Disc2/zzsuf song.flac`],
        ]),
    );

    it("takes the song whose path shares the most trailing folders with the entry", async () => {
        expect(await match(entry("Whatever/zzsufA/Disc1/zzsuf song.flac"))).toBe(`${P}-suf-a`);
        expect(await match(entry("Disc2/zzsuf song.flac"))).toBe(`${P}-suf-c`);
        expect(await match(entry("C:\\Music\\zzsufB\\Disc2\\zzsuf song.flac"))).toBe(`${P}-suf-c`);
    });

    it("skips an entry when several songs share the longest trailing path", async () => {
        expect(await match(entry("/x/Disc1/zzsuf song.flac"))).toBeNull();
    });

    it("lets the artist and title settle which of the equally long hits the entry means", async () => {
        expect(await match(entry("/x/Disc1/zzsuf song.flac", `${P}-suf band`, `${P} suf second`))).toBe(`${P}-suf-b`);
    });

    it("does not count a leading slash or ./ as a folder", async () => {
        expect(await match(entry("/zzsuf song.flac"))).toBeNull();
        expect(await match(entry("./zzsuf song.flac"))).toBeNull();
    });

    it("does not read %2F in a name as a folder", async () => {
        expect(await match(entry("zzsufB/Disc2%2Fzzsuf song.flac"))).toBeNull();
        expect(await match(entry("zzsufB/Disc2/zzsuf%20song.flac"))).toBe(`${P}-suf-c`);
    });
});

describe("a song stored at the music root (no folder) is found by its file name", () => {
    beforeAll(() => seedSongs("root", `${P}-root band`, [["a", `${P} root song`, "zzroot song.flac"]]));

    it("matches a path from another machine, in any letter case", async () => {
        expect(await match(entry("/elsewhere/zzroot song.flac"))).toBe(`${P}-root-a`);
        expect(await match(entry("C:\\Music\\ZZROOT Song.FLAC"))).toBe(`${P}-root-a`);
    });
});

describe("tier 2 tries every reading of the path before skipping an entry", () => {
    beforeAll(() =>
        seedSongs("read", `${P}-read band`, [
            ["a", `${P} read one`, `${P}/read/one/zzread%20song.flac`],
            ["b", `${P} read two`, `${P}/read/two/zzread%20song.flac`],
            ["c", `${P} read three`, `${P}/read/three/zzread song.flac`],
        ]),
    );

    it("takes the first reading that names exactly one song when an earlier reading names several", async () => {
        // As typed the name is "zzread%20song.flac" (two songs); decoded it is "zzread song.flac" (one).
        expect(await match(entry("/x/zzread%20song.flac"))).toBe(`${P}-read-c`);
    });

    it("skips the entry when no reading names exactly one song", async () => {
        expect(await match(entry("/x/zzdup song.flac"))).toBeNull();
    });
});

describe("tier 4 breaks a tie by the exact artist, then the lowest id", () => {
    const names = { exact: "zzquartz band", wider: "zzquartz band extra" };
    beforeAll(async () => {
        // The lower id belongs to the wider artist name, which scores the same on the artist (a subset of words).
        await seedSongs("t4a", names.wider, [["a-first", "zzquartz hello world remastered", `${P}/t4/wider/one.flac`]]);
        await seedSongs("t4z", names.exact, [
            ["c-late", "zzquartz hello world remastered", `${P}/t4/exact/two.flac`],
            ["b-early", "zzquartz hello world remastered", `${P}/t4/exact/three.flac`],
        ]);
    });

    it("prefers the exact artist over a lower id", async () => {
        const got = await match(entry("/nowhere/zzquartz-nothing.flac", names.exact, "zzquartz hello world"));
        expect(got).toMatch(new RegExp(`^${P}-t4z-`));
    });

    it("then takes the lowest id", async () => {
        expect(await match(entry("/nowhere/zzquartz-nothing.flac", names.exact, "zzquartz hello world"))).toBe(`${P}-t4z-b-early`);
    });
});

describe("when no entry matches", () => {
    const nothing = [entry("/nowhere/zzthing.flac", "Nobody", "Nothing"), entry("zzother.flac")];

    it("makes no playlist and throws, naming how many entries had no match", async () => {
        const name = `${P}-none-list`;
        const result = spotifyImportService.importFromM3U(USER, name, nothing);
        await expect(result).rejects.toBeInstanceOf(M3UNothingMatched);
        await expect(result).rejects.toMatchObject({ total: 2 });
        expect(await prisma.playlist.count({ where: { userId: USER, name } })).toBe(0);
    });

    it("tells the owner in the notification tray, as a failed import is told", async () => {
        const name = `${P}-none-notice`;
        await spotifyImportService.importFromM3U(USER, name, nothing).catch(() => undefined);
        const rows = await prisma.notification.findMany({ where: { userId: USER, type: "error" } });
        expect(rows.length).toBeGreaterThan(0);
        const row = rows.find((r) => r.message?.includes(name));
        expect(row).toMatchObject({ title: "Import failed", groupKey: expect.stringContaining("import-failed:") });
    });

    it("still makes the playlist when at least one entry matches", async () => {
        await seedSongs("some", `${P}-some band`, [["a-real", `${P} some real`, `${P}/some/album/zzsome song.flac`]]);
        expect(await matches([entry("/nowhere/zzthing.flac", "Nobody", "Nothing"), entry("/elsewhere/zzsome song.flac")])).toEqual([`${P}-some-a-real`]);
    });
});
