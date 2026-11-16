/**
 * The library song each M3U entry names, through the matching part's `matchM3UEntries`: in the file's order, null for
 * an entry with none, by path first and by artist and title when the path leads nowhere. The tier rules in detail are
 * checked through the import in the m3u* integration tests. Real database.
 */
import { prisma } from "../../utils/db";
import { matchM3UEntries } from "../playlistImport/matching";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-m3u-match";

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    const artist = await prisma.artist.create({ data: { name: `${P} band`, normalizedName: `${P} band`, identityKey: `${P}-band` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-rg`, identityKey: `${P}-album`, primaryType: "Album", title: `${P} album`, artistId: artist.id, location: "LIBRARY" },
    });
    const song = (id: string, title: string, filePath: string, n: number, extra: object = {}) =>
        prisma.track.create({ data: { id: `${P}-${id}`, title, albumId: album.id, trackNo: n, duration: 100, filePath, fileModified: new Date(), fileSize: 1, ...extra } });
    await song("by-path", `${P} first tune`, `${P} band/${P} album/01 ${P} first tune.flac`, 1);
    await song("by-name", `${P} second distinct tune`, `${P} band/${P} album/02 ${P} second distinct tune.flac`, 2);
    await song("gone", "Vanished lullaby for xylophone", `${P} band/${P} album/03 vanished lullaby.flac`, 3, { missingSince: new Date() });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const entry = (filePath: string, artist: string | null = null, title: string | null = null) => ({ filePath, artist, title, durationSeconds: null });

it("answers each entry in order: the song its path names, the song its artist and title name, and null for the rest", async () => {
    const found = await matchM3UEntries([
        entry(`${P} band/${P} album/01 ${P} first tune.flac`),
        entry("/elsewhere/other-name.mp3", `${P} band`, `${P} second distinct tune`),
        entry("/elsewhere/nothing.mp3", "Nobody", "Nothing"),
    ]);
    expect(found.map((song) => song?.id ?? null)).toEqual([`${P}-by-path`, `${P}-by-name`, null]);
});

it("never names a song whose file is missing", async () => {
    const found = await matchM3UEntries([entry(`${P} band/${P} album/03 vanished lullaby.flac`, `${P} band`, "Vanished lullaby for xylophone")]);
    expect(found).toEqual([null]);
});

it("answers nothing for no entries", async () => {
    expect(await matchM3UEntries([])).toEqual([]);
});
