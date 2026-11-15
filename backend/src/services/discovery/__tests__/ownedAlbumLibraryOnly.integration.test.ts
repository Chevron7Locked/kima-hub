/**
 * Only a library album counts as already owned in Discover's checks. An album that is itself in Discover is not owned
 * (discover.md: "Discover is only Discover"), whether the check asks by release-group id or by artist and title. An
 * ownership record counts as owned unless the album it names is in Discover. Real database; no Lidarr set up.
 */
import { prisma } from "../../../utils/db";
import { discoverySeeding } from "../discoverySeeding";
import { forgetOwnedIndex } from "../ownedIndexVersion";
import { discoverWeeklyService } from "../../discoverWeekly";
import { artistIdentityKey } from "../../artistIdentity";
import { useNoLidarr } from "../../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const P = "zz-ola_";
const NAME = `${P}Cat Power`;
const TITLE = `${P}Moon Pix`;
const USER = `${P}user`;
const OTHER = `${P}other`;
const RG = `${P}rg`;

async function wipeRows() {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: OTHER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

const seedArtist = () => prisma.artist.create({ data: { id: `${P}ar`, name: NAME, identityKey: artistIdentityKey(NAME) } });
const seedAlbum = (location: "LIBRARY" | "DISCOVER") =>
    prisma.album.create({
        data: { id: `${P}al`, artistId: `${P}ar`, title: TITLE, identityKey: `${P}al`, rgMbid: RG, primaryType: "Album", location },
    });

/** The check by release-group id, as Discover asks it of a candidate. */
const ownedById = () => discoverySeeding.isAlbumOwned(RG, USER);
/** The check by artist and title under a release-group id no row knows, so only the names can answer. */
const ownedByNames = () => discoverySeeding.isAlbumOwned(`${P}other-rg`, USER, NAME, TITLE, null);
/** Discover's other check, by names alone. */
const ownedByName = (): Promise<boolean> => (discoverWeeklyService as any).isAlbumOwnedByName(NAME, TITLE, null);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
    await wipeRows();
    await useNoLidarr();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.user.create({ data: { id: OTHER, username: OTHER, passwordHash: "x" } });
});
beforeEach(async () => {
    await wipeRows();
    forgetOwnedIndex();
});
afterAll(async () => {
    await wipeRows();
    await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
    await closeEngineConnections();
});

describe("a library album is owned", () => {
    it("by release-group id and by artist and title", async () => {
        await seedArtist();
        await seedAlbum("LIBRARY");

        expect(await ownedById()).toBe(true);
        expect(await ownedByNames()).toBe(true);
        expect(await ownedByName()).toBe(true);
    });
});

describe("a Discover album is not owned", () => {
    it("by release-group id, nor by artist and title", async () => {
        await seedArtist();
        await seedAlbum("DISCOVER");

        expect(await ownedById()).toBe(false);
        expect(await ownedByNames()).toBe(false);
        expect(await ownedByName()).toBe(false);
    });

    it("even with an ownership record that names it", async () => {
        await seedArtist();
        await seedAlbum("DISCOVER");
        await prisma.ownedAlbum.create({ data: { artistId: `${P}ar`, rgMbid: RG, source: "native_scan" } });

        expect(await ownedById()).toBe(false);
        expect(await ownedByNames()).toBe(false);
        expect(await ownedByName()).toBe(false);
    });
});

describe("an ownership record whose album row is gone", () => {
    it("still counts as owned", async () => {
        await seedArtist();
        await prisma.ownedAlbum.create({ data: { artistId: `${P}ar`, rgMbid: RG, source: "discovery_liked" } });
        await prisma.discoveryAlbum.create({
            data: {
                userId: OTHER, rgMbid: RG, artistName: NAME, albumTitle: TITLE,
                weekStartDate: new Date(), status: "LIKED", similarity: 0.9, tier: "core",
            },
        });

        expect(await ownedById()).toBe(true);
        expect(await ownedByNames()).toBe(true);
        expect(await ownedByName()).toBe(true);
    });
});
