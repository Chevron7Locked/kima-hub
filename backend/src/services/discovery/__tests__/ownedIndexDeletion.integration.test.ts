/**
 * The owned-album snapshot behind Discover's fuzzy ownership check is rebuilt after the prune removes an album that
 * holds no songs. The test reads the answer once (so the snapshot is cached), prunes through the real writer, and asks
 * again. Real database; no Lidarr set up.
 */
import { prisma } from "../../../utils/db";
import { discoverySeeding } from "../discoverySeeding";
import { forgetOwnedIndex } from "../ownedIndexVersion";
import { pruneEmptyAlbumsAndArtists } from "../../libraryPrune";
import { artistIdentityKey } from "../../artistIdentity";
import { useNoLidarr } from "../../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const P = "zz-oid_";
const NAME = `${P}Stephen Malkmus`;
const TITLE = `${P}Pig Lib`;
const USER = `${P}user`;

async function wipeRows() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** The fuzzy check of isAlbumOwned, under a release id no row knows, so only the cached names can answer. */
const owned = () => discoverySeeding.isAlbumOwned(`${P}other-rg`, USER, NAME, TITLE, null);

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

describe("the owned-album check reads a deletion at once, not after the snapshot expires", () => {
    it("stops counting a library album the prune removed for holding no songs", async () => {
        await prisma.artist.create({ data: { id: `${P}ar`, name: NAME, identityKey: artistIdentityKey(NAME) } });
        await prisma.album.create({
            data: { id: `${P}al`, artistId: `${P}ar`, title: TITLE, identityKey: `${P}al`, rgMbid: `${P}rg`, primaryType: "Album", location: "LIBRARY" },
        });
        expect(await owned()).toBe(true);

        await pruneEmptyAlbumsAndArtists();

        expect(await prisma.album.count({ where: { id: `${P}al` } })).toBe(0);
        expect(await owned()).toBe(false);
    });
});
