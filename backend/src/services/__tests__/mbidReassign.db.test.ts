/**
 * reassignAlbumRgMbid on the real database: the album and every row keyed on its old id move
 * together — ownership under any artist with its source kept (a clash keeps the more protective
 * one), Discover rows and exclusions — and nothing is created that did not exist. A taken id
 * changes nothing; a stale expected id changes nothing. resolveAlbum lets a file tag replace an
 * id identification chose by AcoustID, never one from tags.
 */

import { prisma } from "../../utils/db";
import { DuplicateMbidError, reassignAlbumRgMbid } from "../mbidReassign";
import { resolveAlbum } from "../albumIdentity";

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const P = "t25db";
const id = (s: string) => `${P}_${s}`;
const OLD = `temp-${P}-old`;
const NEW = "f765fa78-96b2-4a72-b8c7-c1d7eecbae92";
const OTHER = "48117b90-a16e-34ca-a514-19c702df1158";
const WEEK1 = new Date("2026-09-21T05:00:00.000Z");
const WEEK2 = new Date("2026-09-28T05:00:00.000Z");

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoverExclusion" WHERE "userId" = $1`, id("u1"));
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryAlbum" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `${P}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = $1`, id("u1"));
}

/** An album on the old id, its artist, a compilation's second artist and a user. */
async function seed(opts: { owned?: Array<[string, string]> } = {}) {
    await prisma.user.create({ data: { id: id("u1"), username: id("user1"), passwordHash: "x" } });
    await prisma.artist.create({ data: { id: id("art"), name: "Perturbator", identityKey: id("art") } });
    await prisma.artist.create({ data: { id: id("art2"), name: "Guest Artist", identityKey: id("art2") } });
    await prisma.album.create({
        data: { id: id("alb"), title: "Dangerous Days", identityKey: "dangerousdays", artistId: id("art"), rgMbid: OLD, primaryType: "Album" },
    });
    for (const [artistId, source] of opts.owned ?? []) {
        await prisma.ownedAlbum.create({ data: { artistId, rgMbid: OLD, source } });
    }
}

const owned = () =>
    prisma.ownedAlbum.findMany({
        where: { artistId: { startsWith: P } },
        orderBy: [{ artistId: "asc" }, { rgMbid: "asc" }],
        select: { artistId: true, rgMbid: true, source: true },
    });

beforeEach(cleanup);
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("reassignAlbumRgMbid against Postgres", () => {
    it("moves the album and every artist's ownership row, each keeping its source", async () => {
        await seed({ owned: [[id("art"), "native_scan"], [id("art2"), "discovery_liked"]] });

        expect(await reassignAlbumRgMbid(id("alb"), NEW, { source: "acoustid", expectedOld: OLD })).toBe(true);

        const album = await prisma.album.findUnique({ where: { id: id("alb") }, select: { rgMbid: true, rgMbidSource: true } });
        expect(album).toEqual({ rgMbid: NEW, rgMbidSource: "acoustid" });
        expect(await owned()).toEqual([
            { artistId: id("art"), rgMbid: NEW, source: "native_scan" },
            { artistId: id("art2"), rgMbid: NEW, source: "discovery_liked" },
        ]);
    });

    it("creates no ownership row where none existed", async () => {
        await seed();

        await reassignAlbumRgMbid(id("alb"), NEW, { source: "acoustid" });

        expect(await owned()).toEqual([]);
    });

    it("on a clash keeps one row with the more protective source", async () => {
        await seed({ owned: [[id("art"), "native_scan"]] });
        await prisma.ownedAlbum.create({ data: { artistId: id("art"), rgMbid: NEW, source: "enrichment" } });

        await reassignAlbumRgMbid(id("alb"), NEW);

        expect(await owned()).toEqual([{ artistId: id("art"), rgMbid: NEW, source: "native_scan" }]);
    });

    it("moves Discover rows, leaving one whose user and week already hold the new id", async () => {
        await seed();
        const disc = (week: Date, rgMbid: string, leaf: string) =>
            prisma.discoveryAlbum.create({
                data: { id: id(leaf), userId: id("u1"), rgMbid, artistName: "Perturbator", albumTitle: "Dangerous Days", weekStartDate: week },
            });
        await disc(WEEK1, OLD, "collide");
        await disc(WEEK1, NEW, "existing");
        await disc(WEEK2, OLD, "free");

        await reassignAlbumRgMbid(id("alb"), NEW);

        expect((await prisma.discoveryAlbum.findUnique({ where: { id: id("free") } }))?.rgMbid).toBe(NEW);
        expect((await prisma.discoveryAlbum.findUnique({ where: { id: id("collide") } }))?.rgMbid).toBe(OLD);
    });

    it("moves a user's exclusion of the album, keeping the later dates on a clash", async () => {
        await seed();
        const early = new Date("2026-10-01T00:00:00.000Z");
        const late = new Date("2026-12-01T00:00:00.000Z");
        await prisma.discoverExclusion.create({ data: { userId: id("u1"), albumMbid: OLD, expiresAt: late, lastSuggestedAt: early } });
        await prisma.discoverExclusion.create({ data: { userId: id("u1"), albumMbid: NEW, expiresAt: early, lastSuggestedAt: late } });

        await reassignAlbumRgMbid(id("alb"), NEW);

        const rows = await prisma.discoverExclusion.findMany({ where: { userId: id("u1") } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ albumMbid: NEW, expiresAt: late, lastSuggestedAt: late });
    });

    it("a taken id throws and changes nothing", async () => {
        await seed({ owned: [[id("art"), "native_scan"]] });
        await prisma.album.create({
            data: { id: id("alb2"), title: "Dangerous Days (Other)", identityKey: "x", artistId: id("art"), rgMbid: NEW, primaryType: "Album" },
        });

        await expect(reassignAlbumRgMbid(id("alb"), NEW)).rejects.toThrow(DuplicateMbidError);

        expect((await prisma.album.findUnique({ where: { id: id("alb") } }))?.rgMbid).toBe(OLD);
        expect(await owned()).toEqual([{ artistId: id("art"), rgMbid: OLD, source: "native_scan" }]);
    });

    it("the same id confirmed by a stronger source takes that source", async () => {
        await seed();
        await reassignAlbumRgMbid(id("alb"), NEW, { source: "acoustid" });

        expect(await reassignAlbumRgMbid(id("alb"), NEW, { source: "editor" })).toBe(false);
        expect((await prisma.album.findUnique({ where: { id: id("alb") } }))?.rgMbidSource).toBe("editor");
        // A weaker source never lowers it.
        await reassignAlbumRgMbid(id("alb"), NEW, { source: "acoustid" });
        expect((await prisma.album.findUnique({ where: { id: id("alb") } }))?.rgMbidSource).toBe("editor");
    });

    it("an album that no longer has the expected id is left alone", async () => {
        await seed();

        expect(await reassignAlbumRgMbid(id("alb"), NEW, { expectedOld: "temp-something-else" })).toBe(false);
        expect((await prisma.album.findUnique({ where: { id: id("alb") } }))?.rgMbid).toBe(OLD);
    });
});

describe("resolveAlbum: a file's own release-group tag", () => {
    const tagged = (rgMbid: string) => resolveAlbum(prisma, { artistId: id("art"), title: "Dangerous Days", rgMbid });

    it("replaces a placeholder and moves its ownership with it", async () => {
        await seed({ owned: [[id("art"), "native_scan"]] });

        const album = await tagged(NEW);

        expect(album).toMatchObject({ id: id("alb"), rgMbid: NEW, rgMbidSource: "tag" });
        expect(await owned()).toEqual([{ artistId: id("art"), rgMbid: NEW, source: "native_scan" }]);
    });

    it("replaces an id identification chose by AcoustID", async () => {
        await seed();
        await reassignAlbumRgMbid(id("alb"), OTHER, { source: "acoustid" });

        expect(await tagged(NEW)).toMatchObject({ rgMbid: NEW, rgMbidSource: "tag" });
    });

    it("replaces the manual enrich's name-search guess", async () => {
        await seed();
        await reassignAlbumRgMbid(id("alb"), OTHER, { source: "search" });

        expect(await tagged(NEW)).toMatchObject({ rgMbid: NEW, rgMbidSource: "tag" });
    });

    it("confirming an id Kima chose makes it the files' own", async () => {
        await seed();
        await reassignAlbumRgMbid(id("alb"), NEW, { source: "acoustid" });

        expect(await tagged(NEW)).toMatchObject({ rgMbid: NEW, rgMbidSource: "tag" });
    });

    it("never replaces an id from tags or a person", async () => {
        await seed();
        await reassignAlbumRgMbid(id("alb"), OTHER, { source: "editor" });

        expect(await tagged(NEW)).toMatchObject({ rgMbid: OTHER, rgMbidSource: "editor" });
    });
});
