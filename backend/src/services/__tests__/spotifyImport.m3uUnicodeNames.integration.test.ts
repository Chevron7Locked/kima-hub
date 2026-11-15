/**
 * The M3U import reads file names and Unicode forms the way music players do. Through `importFromM3U`, on the suite DB.
 *
 * - Tier 2 (the file name) takes the name from the decoded reading of the path and compares it case-blind, and a name
 *   that differs only in Unicode form (macOS writes decomposed names, Linux libraries store composed ones) is the same name.
 *   It still needs an agreeing artist or title, and the exact-case file still wins over a namesake of another case.
 * - Tier 1 (the path) folds composed and decomposed forms as equal, exactly and with the case of letters ignored, whichever
 *   form is stored.
 * - A Latin-1 `.m3u` with an accented path matches once decoded the way the route decodes it.
 */
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { artistIdentityKey } from "../artistIdentity";
import { m3uSongIds } from "../../__tests__/helpers/m3uImport";
import { decodeM3U, parseM3U, type M3UEntry } from "../m3uParser";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-m3u-unicode";
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

let count = 0;
const entry = (filePath: string, title: string | null = null): M3UEntry => ({ filePath, durationSeconds: null, artist: null, title });
const matches = (entries: M3UEntry[]) => m3uSongIds(USER, `${P}-m3u-${++count}`, entries);
const match = async (filePath: string, title: string | null = null) => (await matches([entry(filePath, title)]))[0] ?? null;

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const root = config.music.musicPath.replace(/\/$/, "");
const NFC = (s: string) => s.normalize("NFC");
const NFD = (s: string) => s.normalize("NFD");

describe("tier 2 takes the file name from the decoded path and compares it case-blind", () => {
    it("a percent-encoded file name finds the song when the title agrees, and only then", async () => {
        await seedSongs("enc", [["a-real", `${P} enc real`, `${P}/enc/Al bum/01 zzenc Sóng.flac`]]);
        const path = "/elsewhere/01%20zzenc%20S%C3%B3ng.flac";
        expect(await match(path, `${P} enc real`)).toBe(`${P}-enc-a-real`);
        expect(await match(path, "a title that disagrees")).toBeNull();
        expect(await match(path)).toBe(`${P}-enc-a-real`);
    });

    it("a file:// URI's file name is decoded too", async () => {
        await seedSongs("uri", [["a-real", `${P} uri real`, `${P}/uri/album/zzuri song.flac`]]);
        expect(await match("file:///elsewhere/zzuri%20song.flac", `${P} uri real`)).toBe(`${P}-uri-a-real`);
    });

    it("a file name in another letter case finds the song", async () => {
        await seedSongs("cas", [["a-real", `${P} cas real`, `${P}/cas/album/Zzcase Song.flac`]]);
        expect(await match("/elsewhere/ZZCASE SONG.FLAC", `${P} cas real`)).toBe(`${P}-cas-a-real`);
        expect(await match("/elsewhere/zzcase song.flac")).toBe(`${P}-cas-a-real`);
        expect(await match("/elsewhere/zzcase song.flac", "a title that disagrees")).toBeNull();
    });

    it("the file name of a backslash path off the library finds the song", async () => {
        await seedSongs("bsl", [["a-real", `${P} bsl real`, `${P}/bsl/album/zzbsl song.flac`]]);
        expect(await match("C:\\Users\\me\\Music\\zzbsl song.flac", `${P} bsl real`)).toBe(`${P}-bsl-a-real`);
    });

    it("an agreeing artist is enough, with the title absent", async () => {
        await seedSongs("art", [["a-real", `${P} art real`, `${P}/art/album/zzart song.flac`]]);
        const withArtist = (artist: string): M3UEntry => ({ filePath: "/elsewhere/ZZART SONG.flac", durationSeconds: null, artist, title: null });
        expect(await matches([withArtist(`${P}-art band`)])).toEqual([`${P}-art-a-real`]);
        expect(await matches([withArtist("somebody else entirely")])).toEqual([]);
    });

    it("the file in the exact case still wins over a namesake in another case", async () => {
        await seedSongs("exa", [
            ["a-upper", `${P} exa upper`, `${P}/exa/one/ZZEXA.flac`],
            ["b-lower", `${P} exa lower`, `${P}/exa/two/zzexa.flac`],
        ]);
        expect(await match("/elsewhere/zzexa.flac")).toBe(`${P}-exa-b-lower`);
        expect(await match("/elsewhere/ZZEXA.flac")).toBe(`${P}-exa-a-upper`);
        // Neither is in the exact case: the lowest id.
        expect(await match("/elsewhere/ZzExA.flac")).toBe(`${P}-exa-a-upper`);
    });

    it("a name of fewer than three letters is still too common to match", async () => {
        await seedSongs("shy", [["a-real", `${P} shy real`, `${P}/shy/album/ab.flac`]]);
        expect(await match("/elsewhere/AB.flac")).toBeNull();
    });
});

describe("a path in the other Unicode form is the same path", () => {
    // A decoy with a lower id sits under the same file name in another folder, so a bare entry that fell through to tier 2
    // would take it: only tier 1 finds the right song.
    async function seed(key: string, storedAs: (s: string) => string) {
        await seedSongs(key, [
            ["a-decoy", `${P} ${key} decoy`, storedAs(`${P}/${key}/decoy/Sóng ${key}.flac`)],
            ["b-real", `${P} ${key} real`, storedAs(`${P}/${key}/Café/Sóng ${key}.flac`)],
        ]);
        return `${P}-${key}-b-real`;
    }

    it("a decomposed path finds a composed stored path", async () => {
        const id = await seed("nfd", NFC);
        expect(await match(NFD(`${root}/${P}/nfd/Café/Sóng nfd.flac`))).toBe(id);
        expect(await match(NFD(`${P}/nfd/Café/Sóng nfd.flac`))).toBe(id);
    });

    it("a composed path finds a decomposed stored path", async () => {
        const id = await seed("nfc", NFD);
        expect(await match(NFC(`${root}/${P}/nfc/Café/Sóng nfc.flac`))).toBe(id);
        expect(await match(NFC(`${P}/nfc/Café/Sóng nfc.flac`))).toBe(id);
    });

    it("the form still stored matches as it did, whichever the song", async () => {
        const id = await seed("same", NFC);
        expect(await match(NFC(`${P}/same/Café/Sóng same.flac`))).toBe(id);
    });

    it("a path of another case and the other form finds the song", async () => {
        const composed = await seed("cnfd", NFC);
        // Capitals for the ASCII letters only: the accented letters keep their case.
        const shout = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase());
        expect(await match(NFD(`${shout(P)}/CNFD/${shout("Caf")}é/S${"ó"}NG CNFD.FLAC`))).toBe(composed);
        const decomposed = await seed("cnfc", NFD);
        expect(await match(NFC(`${shout(P)}/CNFC/${shout("Caf")}é/S${"ó"}NG CNFC.FLAC`))).toBe(decomposed);
    });

    it("a path matches a stored one that differs by the case of an accented letter, in either direction", async () => {
        await seedSongs("acc", [
            ["a-decoy", `${P} acc decoy`, `${P}/acc/decoy/zzacc.flac`],
            ["b-lower", `${P} acc lower`, `${P}/acc/café/zzacc.flac`],
            ["c-upper", `${P} acc upper`, `${P}/acc/ÉCOLE/zzacc.flac`],
        ]);
        expect(await match(`${P}/acc/CAFÉ/zzacc.flac`)).toBe(`${P}-acc-b-lower`);
        expect(await match(NFD(`${P}/ACC/CAFÉ/ZZACC.flac`))).toBe(`${P}-acc-b-lower`);
        expect(await match(`${P}/acc/école/zzacc.flac`)).toBe(`${P}-acc-c-upper`);
        expect(await match(NFD(`${P}/acc/école/zzacc.flac`))).toBe(`${P}-acc-c-upper`);
    });

    it("a path in the other form that names no song matches nothing", async () => {
        await seed("none", NFC);
        expect(await match(NFD(`${P}/none/Café/Sóng other.flac`))).toBeNull();
    });
});

describe("tier 2 folds Unicode forms", () => {
    it("a decomposed file name finds a composed stored one, and the other way round", async () => {
        await seedSongs("fnc", [["a-real", `${P} fnc real`, NFC(`${P}/fnc/album/zzfnc Sóng.flac`)]]);
        await seedSongs("fnd", [["a-real", `${P} fnd real`, NFD(`${P}/fnd/album/zzfnd Sóng.flac`)]]);
        expect(await match(NFD("/elsewhere/zzfnc Sóng.flac"), `${P} fnc real`)).toBe(`${P}-fnc-a-real`);
        expect(await match(NFC("/elsewhere/zzfnd Sóng.flac"), `${P} fnd real`)).toBe(`${P}-fnd-a-real`);
        expect(await match(NFD("/elsewhere/zzfnc Sóng.flac"), "a title that disagrees")).toBeNull();
    });

    it("a decomposed file name of another letter case finds the song", async () => {
        await seedSongs("fcs", [["a-real", `${P} fcs real`, NFC(`${P}/fcs/album/Zzfcs Sóng.flac`)]]);
        expect(await match(NFD("/elsewhere/ZZFCS sóng.FLAC"), `${P} fcs real`)).toBe(`${P}-fcs-a-real`);
        // A capital accented letter against a lower-case one, and the reverse: the database folds ASCII case only.
        expect(await match("/elsewhere/ZZFCS SÓNG.flac", `${P} fcs real`)).toBe(`${P}-fcs-a-real`);
        await seedSongs("fcu", [["a-real", `${P} fcu real`, `${P}/fcu/album/zzfcu SÓNG.flac`]]);
        expect(await match("/elsewhere/zzfcu sóng.flac", `${P} fcu real`)).toBe(`${P}-fcu-a-real`);
    });
});

describe("a Latin-1 .m3u", () => {
    it("matches a song by an accented path once read the way the route reads it", async () => {
        await seedSongs("lat", [
            ["a-decoy", `${P} lat decoy`, `${P}/lat/decoy/Sóng lat.flac`],
            ["b-real", `${P} lat real`, `${P}/lat/Café/Sóng lat.flac`],
        ]);
        // "é" is 0xE9 and "ó" is 0xF3 in Latin-1: not valid UTF-8, so the whole file reads as Windows-1252.
        const bytes = Buffer.from(`#EXTM3U\n${P}/lat/Café/Sóng lat.flac\n`, "latin1");
        expect(bytes.includes(0xe9)).toBe(true);
        const entries = parseM3U(decodeM3U(bytes));
        expect(await matches(entries)).toEqual([`${P}-lat-b-real`]);
    });
});

describe("one import still reads what it has already read once", () => {
    it("20 entries naming a file in different cases read that file name once, and the case-blind path read is one", async () => {
        await seedSongs("memo", [["a-real", `${P} memo real`, `${P}/memo/album/zzmemo song.flac`]]);
        const findMany = jest.spyOn(prisma.track, "findMany");
        const raw = jest.spyOn(prisma, "$queryRaw");
        try {
            const cases = ["zzmemo song.flac", "ZZMEMO SONG.FLAC", "Zzmemo Song.flac", "zzmemo song.FLAC"];
            const ids = await matches(Array.from({ length: 20 }, (_, n) => entry(`/folder${n}/${cases[n % cases.length]}`)));
            expect(ids).toEqual([`${P}-memo-a-real`]);
            const wheres = findMany.mock.calls.map(([args]) => JSON.stringify(args?.where ?? {}));
            expect(wheres.filter((w) => w.includes('"endsWith"')).length).toBe(1);
            const rawSql = raw.mock.calls.map(([sql]) => (sql as unknown as { join(s: string): string }).join("?"));
            expect(rawSql.filter((q) => q.includes("lower(")).length).toBeLessThanOrEqual(1);
        } finally {
            findMany.mockRestore();
            raw.mockRestore();
        }
    });
});
