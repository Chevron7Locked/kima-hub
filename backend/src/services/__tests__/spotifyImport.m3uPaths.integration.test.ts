/**
 * The M3U import's tier 1 reads a path the way music players read it, and one import reads what it has already read
 * once. Through `importFromM3U`, on the suite DB.
 *
 * - A percent-encoded path, a `file://` URI, a relative path (`./`, `../`), a backslash path and a path that differs only
 *   by case each find the song at tier 1. Each song has a decoy of the same file name in another folder with a lower id,
 *   which the file-name tier would take, so only tier 1 finds the right one.
 * - A path as typed still wins over its decoded reading, and the exact path over a case-only namesake.
 * - A 1,000-entry M3U for one artist reads that artist's songs once, and a file name once, not once per entry.
 */
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { artistIdentityKey } from "../artistIdentity";
import { m3uSongIds } from "../../__tests__/helpers/m3uImport";
import type { M3UEntry } from "../m3uParser";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-m3u-paths";
const USER = `${P}-user`;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: artistIdentityKey(P) } } });
}

/** One artist, one album, with the songs given as [id suffix, title, file path stored relative to the music folder]. */
async function seedSongs(key: string, songs: [string, string, string][]) {
    const name = `${P}-${key} band`;
    const artist = await prisma.artist.create({ data: { name, normalizedName: name.toLowerCase(), identityKey: artistIdentityKey(name) } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}-album`, primaryType: "Album", title: `${P} ${key} album`, artistId: artist.id, location: "LIBRARY" },
    });
    for (const [n, [suffix, title, filePath]] of songs.entries()) {
        await prisma.track.create({
            data: { id: `${P}-${key}-${suffix}`, title, albumId: album.id, trackNo: n + 1, duration: 100, filePath, fileModified: new Date(), fileSize: 1 },
        });
    }
}

/** A real song and a decoy with a lower id, in another folder under the same file name `decoyName`. */
async function seedWithDecoy(key: string, realPath: string, decoyName: string) {
    await seedSongs(key, [
        ["a-decoy", `${P} ${key} decoy`, `${P}/${key}/decoy/${decoyName}`],
        ["b-real", `${P} ${key} real`, realPath],
    ]);
    return `${P}-${key}-b-real`;
}

type Entry = M3UEntry;

let count = 0;
const bare = (filePath: string): Entry => ({ filePath, durationSeconds: null, artist: null, title: null });
const matches = (entries: Entry[]) => m3uSongIds(USER, `${P}-m3u-${++count}`, entries);
const match = async (filePath: string) => (await matches([bare(filePath)]))[0] ?? null;

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const root = config.music.musicPath.replace(/\/$/, "");

describe("tier 1 reads a path the way a music player does", () => {
    it("a percent-encoded path finds the song", async () => {
        const id = await seedWithDecoy("pct", `${P}/pct/Al bum/01 Sóng.flac`, "01%20S%C3%B3ng.flac");
        expect(await match(`${root}/${P}/pct/Al%20bum/01%20S%C3%B3ng.flac`)).toBe(id);
    });

    it("a file:// URI finds the song, with or without a host", async () => {
        const id = await seedWithDecoy("uri", `${P}/uri/Al bum/01 song.flac`, "01%20song.flac");
        expect(await match(`file://${root}/${P}/uri/Al%20bum/01%20song.flac`)).toBe(id);
        expect(await match(`file://localhost${root}/${P}/uri/Al%20bum/01%20song.flac`)).toBe(id);
        expect(await match(`FILE://${root}/${P}/uri/Al%20bum/01%20song.flac`)).toBe(id);
    });

    it("a relative path finds the song, the playlist's own folder being unknown", async () => {
        const id = await seedWithDecoy("rel", `${P}/rel/album/song.flac`, "song.flac");
        expect(await match(`./${P}/rel/album/song.flac`)).toBe(id);
        expect(await match(`../${P}/rel/album/song.flac`)).toBe(id);
        expect(await match(`../../${P}/rel/album/song.flac`)).toBe(id);
        expect(await match(`${P}/rel/./album/../album/song.flac`)).toBe(id);
    });

    it("a backslash path finds the song", async () => {
        const id = await seedWithDecoy("bsl", `${P}/bsl/album/song.flac`, `${P}\\bsl\\album\\song.flac`);
        expect(await match(`${P}\\bsl\\album\\song.flac`)).toBe(id);
        expect(await match(`${root}\\${P}\\bsl\\album\\song.flac`)).toBe(id);
        expect(await match(`.\\${P}\\bsl\\album\\song.flac`)).toBe(id);
    });

    it("a path that differs only by case finds the song", async () => {
        const id = await seedWithDecoy("cas", `${P}/cas/Album/Song.flac`, "SONG.FLAC");
        expect(await match(`${root}/${P}/CAS/album/SONG.FLAC`)).toBe(id);
        expect(await match(`${P}/cas/ALBUM/song.flac`)).toBe(id);
    });

    it("a case-insensitive match treats _ and % in a name as themselves", async () => {
        await seedSongs("wild", [
            ["a-other", `${P} wild other`, `${P}/wild/a-b.flac`],
            ["b-real", `${P} wild real`, `${P}/wild/a_b.flac`],
        ]);
        expect(await match(`${P}/WILD/A_B.FLAC`)).toBe(`${P}-wild-b-real`);
        expect(await match(`${P}/WILD/%.FLAC`)).toBeNull();
    });
});

describe("what tier 1 matched before still matches", () => {
    it("a name as typed wins over its percent-decoded reading", async () => {
        await seedSongs("lit", [
            ["a-decoded", `${P} lit decoded`, `${P}/lit/a b.flac`],
            ["b-literal", `${P} lit literal`, `${P}/lit/a%20b.flac`],
        ]);
        expect(await match(`${root}/${P}/lit/a%20b.flac`)).toBe(`${P}-lit-b-literal`);
    });

    it("a name holding a stray % still matches as typed", async () => {
        await seedSongs("off", [["a-real", `${P} off real`, `${P}/off/50% off.flac`]]);
        expect(await match(`${root}/${P}/off/50% off.flac`)).toBe(`${P}-off-a-real`);
    });

    it("the exact path wins over a namesake that differs by case", async () => {
        await seedSongs("exa", [
            ["a-upper", `${P} exa upper`, `${P}/exa/SONG.flac`],
            ["b-lower", `${P} exa lower`, `${P}/exa/song.flac`],
        ]);
        expect(await match(`${P}/exa/song.flac`)).toBe(`${P}-exa-b-lower`);
    });

    it("a path outside the library still finds the song by its file name", async () => {
        await seedSongs("nam", [["a-real", `${P} nam real`, `${P}/nam/album/zzunique song.flac`]]);
        expect(await match(`/elsewhere/zzunique song.flac`)).toBe(`${P}-nam-a-real`);
    });

    it("a path that names no song matches nothing", async () => {
        expect(await match(`../${P}/none/nothing here.flac`)).toBeNull();
    });
});

describe("one import reads what it has already read once", () => {
    const COUNT = 1000;
    let artistSongReads = 0;
    let sweepReads = 0;
    let caseBlindReads = 0;
    let fileNameReads = 0;

    /** Runs `entries` through an import and counts the reads of an artist's songs, by tier. */
    async function counted(entries: Entry[]) {
        const findMany = jest.spyOn(prisma.track, "findMany");
        const raw = jest.spyOn(prisma, "$queryRaw");
        try {
            const ids = await matches(entries);
            const calls = findMany.mock.calls.map(([args]) => JSON.stringify(args?.where ?? {}));
            artistSongReads = calls.filter((w) => w.includes('"album":{"artist"')).length;
            fileNameReads = calls.filter((w) => w.includes('"endsWith"')).length;
            // The word sweeps are the raw reads that match artist names; the case-blind path read is another.
            const rawSql = raw.mock.calls.map(([sql]) => (sql as unknown as { join(s: string): string }).join("?"));
            sweepReads = rawSql.filter((q) => q.includes("normalizedName")).length;
            caseBlindReads = rawSql.filter((q) => q.includes("lower(")).length;
            return ids;
        } finally {
            findMany.mockRestore();
            raw.mockRestore();
        }
    }

    it("1,000 entries for one artist read that artist's songs once, and still match what they matched", async () => {
        const artist = `${P}-bulk band`;
        const songs: [string, string, string][] = Array.from({ length: 5 }, (_, n) => [`s${n}`, `${P} bulk song ${n}`, `${P}/bulk/song ${n}.flac`]);
        await seedSongs("bulk", songs);
        const entries: Entry[] = Array.from({ length: COUNT }, (_, n) => ({
            filePath: `/elsewhere/${P}-bulk-file-${n}.mp3`,
            durationSeconds: null,
            artist,
            // The first five name a song; the rest name none.
            title: n < 5 ? `${P} bulk song ${n}` : `zq nothing like it ${n}`,
        }));
        const ids = await counted(entries);
        expect(ids).toEqual(Array.from({ length: 5 }, (_, n) => `${P}-bulk-s${n}`));
        expect(artistSongReads).toBe(1);
        // The fuzzy tier's word sweep is one query, and its songs load in one chunk.
        expect(sweepReads).toBe(1);
        // The case-blind path compare is one read for the whole import, not one per missed path.
        expect(caseBlindReads).toBe(1);
    });

    it("a file name is looked up once however many entries name it", async () => {
        await seedSongs("fn", [["a-real", `${P} fn real`, `${P}/fn/album/zzrepeat song.flac`]]);
        const ids = await counted(Array.from({ length: 20 }, (_, n) => bare(`/folder${n}/zzrepeat song.flac`)));
        // Each of the 20 lines is a listing, so the one song is held 20 times.
        expect(ids).toEqual(Array(20).fill(`${P}-fn-a-real`));
        expect(fileNameReads).toBe(1);
    });

    it("nothing is kept from one import to the next", async () => {
        await seedSongs("fresh", [["a-real", `${P} fresh real`, `${P}/fresh/zzfresh song.flac`]]);
        const entry = bare(`/x/zzfresh song.flac`);
        await counted([entry]);
        expect(fileNameReads).toBe(1);
        await counted([entry]);
        expect(fileNameReads).toBe(1);
    });
});
