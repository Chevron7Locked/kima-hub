/**
 * The owned-album snapshot behind Discover's fuzzy ownership check is rebuilt after whatever changes it: an album taken
 * into the library, an unlike, an artist's MusicBrainz id backfilled or reassigned. Each test reads the answer once (so the
 * snapshot is cached), makes the change through the real writer, and asks again. Real database; no Lidarr set up.
 */
import { prisma } from "../../../utils/db";
import { discoverySeeding } from "../discoverySeeding";
import { forgetOwnedIndex } from "../ownedIndexVersion";
import { returnToDiscover, takeIntoLibrary } from "../discoveryAlbumLifecycle";
import { reassignArtistMbid } from "../../mbidReassign";
import { artistIdentityKey, resolveArtist } from "../../artistIdentity";
import { useNoLidarr } from "../../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const P = "zz-oif_";
const NAME = `${P}Ed O'Brien`;
const TITLE = `${P}Blue Morpho`;
const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";
const USER = `${P}user`;

async function wipeRows() {
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** The artist with one album of the title, in the given location. */
async function seed(mbid: string | null, location: "LIBRARY" | "DISCOVER") {
    await prisma.artist.create({ data: { id: `${P}ar`, name: NAME, identityKey: artistIdentityKey(NAME), mbid } });
    await prisma.album.create({
        data: { id: `${P}al`, artistId: `${P}ar`, title: TITLE, identityKey: `${P}al`, rgMbid: `${P}rg`, primaryType: "Album", location },
    });
    await prisma.track.create({
        data: { id: `${P}t`, albumId: `${P}al`, title: "T", trackNo: 1, duration: 200, filePath: `/m/${P}.flac`, fileModified: new Date(), fileSize: 1 },
    });
}

/** The fuzzy check of isAlbumOwned, under a release id no row knows, so only the cached names can answer. */
const owned = (artistMbid: string | null) => discoverySeeding.isAlbumOwned(`${P}other-rg`, USER, NAME, TITLE, artistMbid);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await wipeRows();
    await useNoLidarr();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
});
beforeEach(async () => {
    await wipeRows();
    forgetOwnedIndex();
});
afterAll(async () => {
    await wipeRows();
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("the owned-album check reads a change at once, not after the snapshot expires", () => {
    it("counts an album a like took into the library", async () => {
        await seed(ARTIST, "DISCOVER");
        expect(await owned(ARTIST)).toBe(false);

        await takeIntoLibrary({ id: `${P}al`, artistId: `${P}ar`, rgMbid: `${P}rg` });

        expect(await owned(ARTIST)).toBe(true);
    });

    it("stops counting an album that went back to Discover", async () => {
        await seed(ARTIST, "LIBRARY");
        await prisma.ownedAlbum.create({ data: { artistId: `${P}ar`, rgMbid: `${P}rg`, source: "discovery_liked" } });
        expect(await owned(ARTIST)).toBe(true);

        expect(await returnToDiscover({ id: `${P}al`, artistId: `${P}ar`, rgMbid: `${P}rg` })).toBe(true);

        expect(await owned(ARTIST)).toBe(false);
    });

    it("tells a namesake once the owned artist's id is reassigned", async () => {
        await seed(null, "LIBRARY");
        expect(await owned(ARTIST)).toBe(true);

        await reassignArtistMbid(`${P}ar`, NAMESAKE);

        expect(await owned(ARTIST)).toBe(false);
    });

    it("tells a namesake once a scan backfills the owned artist's id", async () => {
        await seed(null, "LIBRARY");
        expect(await owned(ARTIST)).toBe(true);

        await resolveArtist(prisma, { name: NAME, mbid: NAMESAKE });

        expect(await owned(ARTIST)).toBe(false);
    });
});

describe("forgetOwnedIndex", () => {
    it("is not undone by a read that began before it", async () => {
        await seed(ARTIST, "DISCOVER");
        const before = discoverySeeding.getOwnedAlbumIndex(); // reads the Discover album, then...
        await prisma.album.update({ where: { id: `${P}al` }, data: { location: "LIBRARY" } });
        forgetOwnedIndex(); // ...a writer forgets while that read is still out
        await before;

        expect(await owned(ARTIST)).toBe(true);
    });
});
