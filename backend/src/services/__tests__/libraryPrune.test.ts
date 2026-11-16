/**
 * The prune removes albums with no songs and artists with no albums, but an artist's keep (OwnedAlbum) is the listener's
 * decision and goes only with a deliberate delete, so an artist holding one stays. Real database.
 */
import { prisma } from "../../utils/db";
import { pruneEmptyAlbumsAndArtists } from "../libraryPrune";

const P = "zz-prune_";

const clear = () => prisma.artist.deleteMany({ where: { id: { startsWith: P } } });

beforeEach(clear);
afterAll(clear);

describe("pruneEmptyAlbumsAndArtists", () => {
    it("removes an empty album, and its artist when nothing else is left of it", async () => {
        await prisma.artist.create({ data: { id: `${P}bare`, name: `${P}bare`, identityKey: `${P}bare` } });
        await prisma.album.create({
            data: { id: `${P}al`, rgMbid: `${P}rg`, artistId: `${P}bare`, identityKey: `${P}al`, title: `${P}al`, primaryType: "Album" },
        });

        const result = await pruneEmptyAlbumsAndArtists();

        expect(result.albums).toBeGreaterThanOrEqual(1);
        expect(result.artists).toBeGreaterThanOrEqual(1);
        expect(await prisma.album.count({ where: { id: `${P}al` } })).toBe(0);
        expect(await prisma.artist.count({ where: { id: `${P}bare` } })).toBe(0);
    });

    it("keeps the artist whose last album it removed while the artist still holds a keep", async () => {
        await prisma.artist.create({ data: { id: `${P}kept`, name: `${P}kept`, identityKey: `${P}kept` } });
        await prisma.album.create({
            data: { id: `${P}al2`, rgMbid: `${P}rg2`, artistId: `${P}kept`, identityKey: `${P}al2`, title: `${P}al2`, primaryType: "Album" },
        });
        await prisma.ownedAlbum.create({ data: { artistId: `${P}kept`, rgMbid: `${P}rg2`, source: "discovery_liked" } });

        await pruneEmptyAlbumsAndArtists();

        expect(await prisma.album.count({ where: { id: `${P}al2` } })).toBe(0);
        expect(await prisma.ownedAlbum.findMany({ where: { artistId: `${P}kept` } })).toEqual([
            { artistId: `${P}kept`, rgMbid: `${P}rg2`, source: "discovery_liked" },
        ]);
    });
});
