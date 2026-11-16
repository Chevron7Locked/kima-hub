/**
 * Matching listed songs to the library through the matching part's one ladder (`matchEntries`, `matchEntry`): the
 * songs of the listed artist first, then, for a title long enough to be distinctive, the songs of any artist with that
 * title. Real database. Both ways of reading the title-only candidates give the same verdicts here; what differs is the
 * candidate cap, which applies per read.
 */
import { prisma } from "../../utils/db";
import { matchEntries, matchEntry } from "../playlistImport/matching";
import { loadArtistPool } from "../playlistImport/matching/ladder";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-ladder";
const BAND = `${P} band`;
const OTHER = `${P} various`;
const LONG_TITLE = `${P} a distinctive song name`;
const SHORT_TITLE = "Home";

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: P } } });
}

async function seedAlbum(key: string, artistName: string, location: "LIBRARY" | "DISCOVER" = "LIBRARY") {
    const artist = await prisma.artist.upsert({
        where: { identityKey: `${P}-${artistName}` },
        create: { name: artistName, normalizedName: artistName, identityKey: `${P}-${artistName}` },
        update: {},
    });
    return prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}`, primaryType: "Album", title: `${P} ${key}`, artistId: artist.id, location },
    });
}

let n = 0;
const song = (albumId: string, id: string, title: string, extra: object = {}) =>
    prisma.track.create({
        data: { id: `${P}-${id}`, title, albumId, trackNo: ++n, duration: 100, filePath: `/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1, ...extra },
    });

beforeAll(async () => {
    await cleanup();
    const mine = await seedAlbum("mine", BAND);
    const compilation = await seedAlbum("comp", OTHER);
    const discover = await seedAlbum("disc", `${P} stray`, "DISCOVER");
    await song(mine.id, "own-long", LONG_TITLE);
    await song(mine.id, "own-short", SHORT_TITLE);
    await song(compilation.id, "comp-long", `${P} compilation only title here`);
    await song(compilation.id, "comp-short", `${SHORT_TITLE} ${P}`);
    await song(compilation.id, "comp-missing", `${P} missing file title here`, { missingSince: new Date() });
    await song(discover.id, "disc-long", `${P} a discover title here`);
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const ids = (matches: Array<{ candidate: { id: string } } | null>) => matches.map((m) => m?.candidate.id ?? null);
const MODES = ["together", "each"] as const;

describe.each(MODES)("matchEntries with title reads %s", (titleReads) => {
    it("matches by artist and title, and says it was the artist's songs that gave the verdict", async () => {
        const matches = await matchEntries([{ title: LONG_TITLE, artist: BAND }], { titleReads });
        expect(ids(matches)).toEqual([`${P}-own-long`]);
        expect(matches[0]?.via).toBe("artist");
    });

    it("finds a distinctive title by any artist when the listed artist has no such song", async () => {
        const matches = await matchEntries([{ title: `${P} compilation only title here`, artist: "Nobody Known" }], { titleReads });
        expect(ids(matches)).toEqual([`${P}-comp-long`]);
        expect(matches[0]?.via).toBe("title");
    });

    it("does not match a short title without its artist, but does with it", async () => {
        const matches = await matchEntries(
            [{ title: SHORT_TITLE, artist: "Nobody Known" }, { title: SHORT_TITLE, artist: BAND }],
            { titleReads },
        );
        expect(ids(matches)).toEqual([null, `${P}-own-short`]);
    });

    it("never offers a song that cannot play: a missing file or a Discover album", async () => {
        const matches = await matchEntries(
            [{ title: `${P} missing file title here`, artist: "Nobody Known" }, { title: `${P} a discover title here`, artist: "Nobody Known" }],
            { titleReads },
        );
        expect(ids(matches)).toEqual([null, null]);
    });

    it("answers each listing in order, null where nothing matches", async () => {
        const matches = await matchEntries(
            [{ title: "Nothing like it at all", artist: "Nobody" }, { title: LONG_TITLE, artist: BAND }, { title: `${P} compilation only title here`, artist: "X" }],
            { titleReads },
        );
        expect(ids(matches)).toEqual([null, `${P}-own-long`, `${P}-comp-long`]);
    });

    it("answers nothing for no listings", async () => {
        expect(await matchEntries([], { titleReads })).toEqual([]);
    });
});

describe("matchEntry", () => {
    it("is the same ladder for one listing against a pool read once", async () => {
        const pool = await loadArtistPool([{ title: LONG_TITLE, artist: BAND }]);
        expect((await matchEntry({ title: LONG_TITLE, artist: BAND }, pool))?.candidate.id).toBe(`${P}-own-long`);
        expect((await matchEntry({ title: `${P} compilation only title here`, artist: "Nobody" }, pool))?.via).toBe("title");
        expect(await matchEntry({ title: "Nothing like it at all", artist: "Nobody" }, pool)).toBeNull();
    });
});
