/**
 * Three rules of the M3U import that playlist apps and Navidrome share. Through `importFromM3U`, on the suite DB.
 *
 * - Tier 2 (the file name): when the entry names both an artist and a title, both must agree with the song; one agreeing
 *   field is enough only when the entry has only that field. A miss can still match at tiers 3 and 4.
 * - A file name that more than one library song answers to is skipped, not given to the lowest id: the song sharing the
 *   most trailing path with the entry wins, and equally long hits are skipped (a bare name is a path of one segment).
 * - Tier 4 breaks a score tie by the exact artist, then the lowest id.
 * - Tier 4 scores titles by their words in any order, not by subset: a short title is not any longer title that
 *   contains it ("Love" is not "Love Me Do"), while a featured credit or a remaster note does not count against a title.
 * - Tier 4 finds an artist by the longest word of the entry's name, or by the whole name when every word is short, so
 *   "U2" and "Bo Burnham" reach it and "The Beatles" does not look for "the".
 * - When no entry matches, no playlist is made, the owner gets an "import failed" notification, and the import throws
 *   M3UNothingMatched.
 */
import { prisma } from "../../utils/db";
import { artistIdentityKey, normalizeArtistName } from "../artistIdentity";
import { playlistImportService } from "../playlistImport";
import { M3UNothingMatched, type M3UEntry } from "../playlistImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-m3u-rules";
const USER = `${P}-user`;
/** Artists the tier 4 tests seed under names no other test uses (every word short, a short word first, credits), removed by name. */
const SHORT_ARTISTS = ["zq", "zq xy", "zq zzburnham", "zq & xy", "zzbeetles", "zzqueen", "zzqueen zzlatifah", "zzpinkish zzfloyd", "zzjayz feat. zzkanye", "zzsimon & zzgarf", "zzhall, zzoates / zzthird", "zzflorence + zzmachine", "zzhall/zzoates", "zz/xy"];

async function cleanup() {
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: artistIdentityKey(P) } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: "zzquartz" } } });
    await prisma.artist.deleteMany({ where: { name: { in: SHORT_ARTISTS } } });
}

/** One artist and album holding the songs given as [id suffix, title, file path stored relative to the music folder]. */
async function seedSongs(key: string, artistName: string, songs: [string, string, string][]) {
    const artist = await prisma.artist.create({ data: { name: artistName, normalizedName: normalizeArtistName(artistName), identityKey: artistIdentityKey(artistName) } });
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
    const { playlistId } = await playlistImportService.importFromM3U(USER, `${P}-m3u-${++count}`, entries);
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
        const { unmatched } = await playlistImportService.importFromM3U(USER, `${P}-m3u-${++count}`, entries);
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

describe("a root song and a foldered namesake", () => {
    beforeAll(() =>
        seedSongs("mix", `${P}-mix band`, [
            ["a", `${P} mix one`, "zzmix song_100%.flac"],
            ["b", `${P} mix two`, `${P}/mix/ZZMIX Song_100%.flac`],
        ]),
    );

    it("takes the one in the exact case written, and reads _ and % in a name as themselves", async () => {
        expect(await match(entry("/x/zzmix song_100%.flac"))).toBe(`${P}-mix-a`);
        expect(await match(entry("/x/ZZMIX Song_100%.flac"))).toBe(`${P}-mix-b`);
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
        // The lower id belongs to the wider artist name, which scores lower on the artist (more words).
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

describe("tier 4 scores a title by its words, not by subset", () => {
    const ARTIST = "zzfuzz band";
    beforeAll(async () => {
        await seedSongs("t4t", ARTIST, [
            ["a-me-do", "zzlo me do", `${P}/t4t/one.flac`],
            ["b-stan", "zzstan (feat. zzdido)", `${P}/t4t/two.flac`],
            ["c-jude", "zzhey jude (remastered 2015)", `${P}/t4t/three.flac`],
            ["d-lucky", "zzget lucky - feat. zzpharrell williams", `${P}/t4t/four.flac`],
        ]);
        // A song whose stored title is another's, edited to read as the one the entry names.
        const album = await prisma.album.findFirstOrThrow({ where: { identityKey: `${P}-t4t-album` } });
        await prisma.track.create({
            data: {
                id: `${P}-t4t-e-edited`, title: "zzoriginal wrong", displayTitle: "zzedit song [feat. zzguest]",
                albumId: album.id, trackNo: 9, duration: 100, filePath: `${P}/t4t/five.flac`, fileModified: new Date(), fileSize: 1,
            },
        });
    });
    const byArtist = (title: string) => match(entry("/nowhere/zzfuzz-nothing.flac", ARTIST, title));

    // "zzlo" / "zzlo me do" is the length ratio of "Love" / "Love Me Do" (4 to 10 characters, a title score of 57).
    it("does not import a longer title because it holds all of the entry's words", async () => {
        expect(await byArtist("zzlo")).toBeNull();
    });

    it("still imports the title the entry names, whatever else the library holds", async () => {
        expect(await byArtist("zzlo me do")).toBe(`${P}-t4t-a-me-do`);
    });

    it("imports a song whose title carries a featured credit in parentheses", async () => {
        expect(await byArtist("zzstan")).toBe(`${P}-t4t-b-stan`);
    });

    it("imports a song whose title carries a featured credit after a dash", async () => {
        expect(await byArtist("zzget lucky")).toBe(`${P}-t4t-d-lucky`);
    });

    it("imports a song whose title carries a remaster note", async () => {
        expect(await byArtist("zzhey jude")).toBe(`${P}-t4t-c-jude`);
    });

    it("lets the entry carry the featured credit instead", async () => {
        expect(await byArtist("zzstan ft. zzdido")).toBe(`${P}-t4t-b-stan`);
    });

    it("still scores a title that is only bracketed text, as before", async () => {
        await seedSongs("t4b", "zzbracket band", [["a", "[zzbr one]", `${P}/t4b/one.flac`]]);
        expect(await match(entry("/nowhere/zzbracket-nothing.flac", "zzbracket band", "[zzbr two]"))).toBe(`${P}-t4b-a`);
    });

    it("counts the title a person edited a song to", async () => {
        expect(await byArtist("zzedit song")).toBe(`${P}-t4t-e-edited`);
    });
});

describe("tier 4 finds the artist by the longest word of its name", () => {
    beforeAll(async () => {
        await seedSongs("t4s", "zq", [["a", "zzshort one", `${P}/t4s/one.flac`]]);
        await seedSongs("t4m", "zq xy", [["a", "zzmulti two", `${P}/t4m/one.flac`]]);
        await seedSongs("t4n", "zzbeetles", [["a", "zzlet it be", `${P}/t4n/one.flac`]]);
        await seedSongs("t4w", "zq zzburnham", [["a", "zzinside two", `${P}/t4w/one.flac`]]);
        await seedSongs("t4x", "zq & xy", [["a", "zzamp two", `${P}/t4x/one.flac`]]);
    });

    it("reaches an artist of short words joined by an ampersand, which is stored as the word \"and\"", async () => {
        expect(await match(entry("/nowhere/zq-nothing.flac", "zq & xy", "two zzamp"))).toBe(`${P}-t4x-a`);
    });

    // The titles differ from the stored ones in word order only, which tier 3's exact compare refuses and tier 4 accepts.
    it("reaches a one-word artist whose name is shorter than three letters (U2)", async () => {
        expect(await match(entry("/nowhere/zq-nothing.flac", "zq", "one zzshort"))).toBe(`${P}-t4s-a`);
    });

    it("reaches an artist whose every word is shorter than three letters", async () => {
        expect(await match(entry("/nowhere/zq-nothing.flac", "zq xy", "two zzmulti"))).toBe(`${P}-t4m-a`);
    });

    it("finds an artist whose name has a short word first (Bo Burnham)", async () => {
        expect(await match(entry("/nowhere/zq-nothing.flac", "zq zzburnham", "two zzinside"))).toBe(`${P}-t4w-a`);
    });

    it("finds a library artist that lacks the leading \"the\" the entry has (The Beatles)", async () => {
        expect(await match(entry("/nowhere/zq-nothing.flac", "The zzbeetles", "it zzlet be"))).toBe(`${P}-t4n-a`);
    });
});

describe("tier 4 scores the artist by its whole name, not by a subset of its words", () => {
    beforeAll(async () => {
        // Queen and Queen Latifah, stand-ins: the entry names the shorter artist, the title is the longer artist's.
        await seedSongs("t4q", "zzqueen", [["a", "zzother anthem", `${P}/t4q/one.flac`]]);
        await seedSongs("t4l", "zzqueen zzlatifah", [["a", "zzrhapsody", `${P}/t4l/one.flac`]]);
        await seedSongs("t4p", "zzpinkish zzfloyd", [["a", "zzwall", `${P}/t4p/one.flac`]]);
        // Credits: one of several credited artists is enough.
        await seedSongs("t4c", "zzjayz feat. zzkanye", [["a", "zzcredit one", `${P}/t4c/one.flac`]]);
        await seedSongs("t4d", "zzsimon & zzgarf", [["a", "zzcredit two", `${P}/t4d/one.flac`]]);
        await seedSongs("t4e", "zzhall, zzoates / zzthird", [["a", "zzcredit three", `${P}/t4e/one.flac`]]);
        await seedSongs("t4f", "zzflorence + zzmachine", [["a", "zzcredit four", `${P}/t4f/one.flac`]]);
        // A slash between words of three letters or more splits; between short ones it is part of the name (AC/DC).
        await seedSongs("t4g", "zzhall/zzoates", [["a", "zzcredit five", `${P}/t4g/one.flac`]]);
        await seedSongs("t4h", "zz/xy", [["a", "zzcredit six", `${P}/t4h/one.flac`]]);
    });
    const named = (artist: string, title: string) => match(entry("/nowhere/zzq-nothing.flac", artist, title));

    it("does not import the longer-named artist's song for an entry naming the shorter one, when the library holds both", async () => {
        expect(await named("zzqueen", "zzrhapsody")).toBeNull();
    });

    it("does not import it either when the library holds only the longer-named artist", async () => {
        expect(await named("zzpinkish", "zzwall")).toBeNull();
    });

    it("still imports the song of the artist the entry names, with the leading \"the\" and the case free", async () => {
        expect(await named("The ZZQUEEN", "zzother anthem")).toBe(`${P}-t4q-a`);
    });

    it("still imports a song by one of several credited artists when the entry names that one", async () => {
        expect(await named("zzjayz", "zzcredit one")).toBe(`${P}-t4c-a`);
        expect(await named("zzkanye", "zzcredit one")).toBe(`${P}-t4c-a`);
        expect(await named("zzjayz feat. zzkanye", "zzcredit one")).toBe(`${P}-t4c-a`);
    });

    it("keeps a slash between short words in the name, so one half does not import the whole act's song", async () => {
        expect(await named("zz", "zzcredit six")).toBeNull();
        expect(await named("zz/xy", "zzcredit six")).toBe(`${P}-t4h-a`);
    });

    it.each([
        ["an ampersand", "zzgarf", "zzcredit two"],
        ["a comma", "zzoates", "zzcredit three"],
        ["a slash", "zzthird", "zzcredit three"],
        ["a plus sign", "zzmachine", "zzcredit four"],
        ["a slash without spaces", "zzoates", "zzcredit five"],
    ])("still imports a song of an artist credited with %s when the entry names one of them", async (_how, artist, title) => {
        expect(await named(artist, title)).not.toBeNull();
    });
});

describe("when no entry matches", () => {
    const nothing = [entry("/nowhere/zzthing.flac", "Nobody", "Nothing"), entry("zzother.flac")];

    it("makes no playlist and throws, naming how many entries had no match", async () => {
        const name = `${P}-none-list`;
        const result = playlistImportService.importFromM3U(USER, name, nothing);
        await expect(result).rejects.toBeInstanceOf(M3UNothingMatched);
        await expect(result).rejects.toMatchObject({ total: 2 });
        expect(await prisma.playlist.count({ where: { userId: USER, name } })).toBe(0);
    });

    it("tells the owner in the notification tray, as a failed import is told", async () => {
        const name = `${P}-none-notice`;
        await playlistImportService.importFromM3U(USER, name, nothing).catch(() => undefined);
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
