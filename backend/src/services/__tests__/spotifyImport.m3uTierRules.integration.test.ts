/**
 * Three rules of the M3U import that playlist apps and Navidrome share. Through `importFromM3U`, on the suite DB.
 *
 * - Tier 2 (the file name): when the entry names both an artist and a title, both must agree with the song; one agreeing
 *   field is enough only when the entry has only that field. A miss can still match at tiers 3 and 4.
 * - A bare file name (no directory) that more than one library song answers to is skipped, not given to the lowest id.
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

    it("leaves a name with a directory as it was: the lowest id", async () => {
        expect(await match(entry("/elsewhere/zzdup song.flac"))).toBe(`${P}-dup-a-first`);
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
