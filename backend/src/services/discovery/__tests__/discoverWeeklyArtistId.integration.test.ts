/**
 * Discover Weekly's name-only artist comparisons follow the one artist-identity rule (discoverEvidence's sameArtist):
 * two real MusicBrainz ids that differ are a namesake and never match; a missing or `temp-` id on either side still
 * matches by name; the same ids match. Covers the owned-album checks (so a namesake's album does not suppress a
 * recommendation) and the lookup of a Discover album's songs. Real database; no Lidarr set up.
 */
import { prisma } from "../../../utils/db";
import { discoverWeeklyService } from "../../discoverWeekly";
import { discoverySeeding } from "../discoverySeeding";
import { artistIdentityKey } from "../../artistIdentity";
import { useNoLidarr } from "../../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const P = "zz-dwid_";
const NAME = `${P}Ed O'Brien`;
const TITLE = `${P}Blue Morpho`;
const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";
const PLACEHOLDER = "temp-1793617784650-0.5";
const USER = `${P}user`;

async function wipeRows() {
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

const makeArtist = (mbid: string | null, name = NAME) =>
    prisma.artist.create({ data: { id: `${P}ar`, name, identityKey: artistIdentityKey(name), mbid } });

/** The artist "Ed O'Brien" under `mbid`, with one album of the title and a song, in the given location. */
async function seed(mbid: string | null, location: "LIBRARY" | "DISCOVER", name = NAME) {
    await makeArtist(mbid, name);
    await prisma.album.create({
        data: { id: `${P}al`, artistId: `${P}ar`, title: TITLE, identityKey: `${P}al`, rgMbid: `${P}rg`, primaryType: "Album", location },
    });
    await prisma.track.create({
        data: { id: `${P}t`, albumId: `${P}al`, title: "T", trackNo: 1, duration: 200, filePath: `/m/${P}.flac`, fileModified: new Date(), fileSize: 1 },
    });
}

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await wipeRows();
    await useNoLidarr();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
});
beforeEach(async () => {
    await wipeRows();
    (discoverySeeding as any).ownedIndexCache = null; // the owned-album snapshot is cached for minutes
});
afterAll(async () => {
    await wipeRows();
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("an owned album suppresses a recommendation only for the same artist", () => {
    const ownedByName = (artistMbid: string | null) => (discoverWeeklyService as any).isAlbumOwnedByName(NAME, TITLE, artistMbid);
    const owned = (artistMbid: string | null) => discoverySeeding.isAlbumOwned(`${P}other-rg`, USER, NAME, TITLE, artistMbid);

    describe.each([
        ["isAlbumOwnedByName", ownedByName],
        ["the fuzzy check of isAlbumOwned", owned],
    ])("%s", (_which, check) => {
        it("does not count a namesake's album", async () => {
            await seed(NAMESAKE, "LIBRARY");

            expect(await check(ARTIST)).toBe(false);
        });

        it.each([
            ["the same id", ARTIST, ARTIST],
            ["no id on the owned artist", null, ARTIST],
            ["a temp- id on the owned artist", PLACEHOLDER, ARTIST],
            ["no id on the asked artist", ARTIST, null],
        ])("counts the album with %s", async (_how, ownedId, askedId) => {
            await seed(ownedId, "LIBRARY");

            expect(await check(askedId)).toBe(true);
        });

        it("does not count a namesake's owned album whose album row is gone", async () => {
            // An OwnedAlbum names no title; a suggestion of the same release group does.
            await makeArtist(NAMESAKE);
            await prisma.ownedAlbum.create({ data: { artistId: `${P}ar`, rgMbid: `${P}owned-rg`, source: "native_scan" } });
            await prisma.discoveryAlbum.create({
                data: { userId: USER, rgMbid: `${P}owned-rg`, artistName: NAME, albumTitle: TITLE, weekStartDate: new Date("2026-11-02"), status: "ACTIVE" },
            });

            expect(await check(ARTIST)).toBe(false);
            expect(await check(NAMESAKE)).toBe(true);
        });
    });
});

describe("a Discover album's songs are found for the same artist only", () => {
    const find = (artistMbid: string | null) => (discoverWeeklyService as any).findDiscoverTracksByName(NAME, TITLE, artistMbid);
    const lookup = (artistMbid: string | null) =>
        (discoverWeeklyService as any).discoverAlbumTracks({ artistName: NAME, albumTitle: TITLE, artistMbid });

    describe.each([
        ["findDiscoverTracksByName", find],
        ["discoverAlbumTracks", lookup],
    ])("%s", (_which, search) => {
        it("does not pick up a namesake's songs", async () => {
            await seed(NAMESAKE, "DISCOVER");

            expect(await search(ARTIST)).toEqual([]);
        });

        it.each([
            ["the same id", ARTIST, ARTIST],
            ["no id on the album's artist", null, ARTIST],
            ["a temp- id on the album's artist", PLACEHOLDER, ARTIST],
            ["no id asked", ARTIST, null],
            ["a temp- id asked", ARTIST, PLACEHOLDER],
        ])("finds the songs with %s", async (_how, albumId, askedId) => {
            await seed(albumId, "DISCOVER");

            const songs = await search(askedId);

            expect(songs.map((t: { id: string }) => t.id)).toEqual([`${P}t`]);
        });
    });

    it("finds the songs whatever the apostrophes, accents and case of the names", async () => {
        await seed(null, "DISCOVER", `${P}Ed O'Brién`);
        await prisma.album.update({ where: { id: `${P}al` }, data: { title: `${P}Don't Stop` } });

        const ids = (songs: Array<{ id: string }>) => songs.map((t) => t.id);
        const name = `${P}ED O’BRIEN`;
        const title = `${P}Don’t stop`;

        expect(ids(await (discoverWeeklyService as any).findDiscoverTracksByName(name, title, null))).toEqual([`${P}t`]);
        expect(ids(await (discoverWeeklyService as any).discoverAlbumTracks({ artistName: name, albumTitle: title }))).toEqual([`${P}t`]);
    });

    it("finds the songs of the same real MusicBrainz artist spelt differently, but not of the same name under another id", async () => {
        await seed(ARTIST, "DISCOVER", `${P}Kanye West`);
        const asked = (name: string, mbid: string | null) => (discoverWeeklyService as any).findDiscoverTracksByName(name, TITLE, mbid);

        expect((await asked(`${P}Ye`, ARTIST)).map((t: { id: string }) => t.id)).toEqual([`${P}t`]);
        expect(await asked(`${P}Ye`, NAMESAKE)).toEqual([]);
        expect(await asked(`${P}Ye`, null)).toEqual([]);
    });

    it("does not pick up a namesake's songs by the artist's normalised name either", async () => {
        // "Low" is found inside "Low & Friends" only by the last, looser way.
        await seed(NAMESAKE, "DISCOVER", `${P}Low & Friends`);
        const asked = (mbid: string | null) => (discoverWeeklyService as any).discoverAlbumTracks({ artistName: `${P}Low`, albumTitle: TITLE, artistMbid: mbid });

        expect(await asked(ARTIST)).toEqual([]);
        expect((await asked(NAMESAKE)).map((t: { id: string }) => t.id)).toEqual([`${P}t`]);
        expect((await asked(null)).map((t: { id: string }) => t.id)).toEqual([`${P}t`]);
    });
});
