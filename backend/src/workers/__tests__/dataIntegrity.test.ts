/**
 * The integrity check deletes only what a scan or re-discovery recreates
 * (expired exclusions, orphaned DiscoveryTrack rows, old notifications) and
 * only reports rows that carry a decision: orphaned DISCOVER albums, ghost
 * albums and orphaned OwnedAlbum keeps. Real database, no prisma mock.
 */

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

import { runDataIntegrityCheck } from "../dataIntegrity";

const id = (n: string) => `dint_${n}`;

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" LIKE 'dint_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryTrack" WHERE id LIKE 'dint_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoveryAlbum" WHERE id LIKE 'dint_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "DiscoverExclusion" WHERE id LIKE 'dint_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE 'dint_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE 'dint_%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE 'dint_%'`);
}

beforeEach(async () => {
    await wipe();
});

afterAll(async () => {
    await wipe();
});

describe("data integrity check", () => {
    it("matches a Discover album to its suggestion by the shared name fold, and counts an empty album as empty", async () => {
        await prisma.user.create({ data: { id: id("user2"), username: id("user2"), passwordHash: "x" } });
        await prisma.artist.create({ data: { id: id("art2"), name: "Röyksopp", identityKey: id("k2") } });
        // Suggested as "Royksopp - Don't Go"; the scanner made "Röyksopp - Don’t Go" under another id.
        await prisma.discoveryAlbum.create({
            data: { id: id("da2"), userId: id("user2"), rgMbid: id("rg-suggested"), artistName: "Royksopp", albumTitle: "Don't Go", weekStartDate: new Date() },
        });
        await prisma.album.create({
            data: { id: id("alb2"), rgMbid: id("rg-scanned"), artistId: id("art2"), identityKey: id("ik2"), title: "Don’t Go", primaryType: "Album", location: "DISCOVER" },
        });
        await prisma.track.create({
            data: { id: id("t2"), albumId: id("alb2"), title: "x", trackNo: 1, duration: 1, filePath: "/tmp/dint2.flac", fileModified: new Date(), fileSize: 1 },
        });
        await prisma.album.create({
            data: { id: id("alb3"), rgMbid: id("rg-empty"), artistId: id("art2"), identityKey: id("ik3"), title: "Nothing Left", primaryType: "Album" },
        });
        const warn = jest.spyOn(logger, "warn");
        let report: Awaited<ReturnType<typeof runDataIntegrityCheck>>;
        let warned: string[];
        try {
            report = await runDataIntegrityCheck();
            warned = warn.mock.calls.map((c) => String(c[0]));
        } finally {
            warn.mockRestore();
        }

        expect(warned.filter((w) => w.includes("Don’t Go"))).toEqual([]);
        expect(warned.some((w) => w.includes("Nothing Left"))).toBe(true);
        expect(report.emptyAlbums).toBeGreaterThanOrEqual(1);
    });

    it("keeps every OwnedAlbum keep whose album is missing and reports them", async () => {
        // A user kept a discovery album; its Album row was removed
        // out-of-band (pruned, rgMbid corrected). The keep is a decision.
        await prisma.artist.create({
            data: { id: id("art"), name: "Kept Artist", identityKey: id("k") },
        });
        // Give the artist a live album (a different rgMbid than the keep's)
        // so section 8's no-albums artist cleanup doesn't cascade the keep
        // away — this test isolates section 6.
        await prisma.album.create({
            data: {
                id: id("alb"),
                rgMbid: id("rg-real"),
                artistId: id("art"),
                title: "Real Album",
                primaryType: "Album",
            },
        });
        await prisma.ownedAlbum.create({
            data: { artistId: id("art"), rgMbid: id("rg-missing"), source: "discovery_liked" },
        });

        const report = await runDataIntegrityCheck();

        // ≥1, not exactly 1: other fixtures on this worker DB may leave
        // their own orphan keeps; the claim is that ours is counted and kept.
        expect(report.orphanedOwnedAlbums).toBeGreaterThanOrEqual(1);
        const stillThere = await prisma.ownedAlbum.findFirst({
            where: { artistId: id("art") },
        });
        expect(stillThere).not.toBeNull();
        expect(stillThere?.source).toBe("discovery_liked");

        // A second run reports it again — nothing deleted it in between.
        const second = await runDataIntegrityCheck();
        expect(second.orphanedOwnedAlbums).toBeGreaterThanOrEqual(1);
        expect(
            await prisma.ownedAlbum.findFirst({ where: { artistId: id("art") } }),
        ).not.toBeNull();
    });

    it("still clears rows a re-discovery recreates: expired exclusions and orphaned discovery tracks", async () => {
        await prisma.user.create({
            data: { id: id("user"), username: id("user"), passwordHash: "x" },
        });
        await prisma.discoverExclusion.create({
            data: {
                id: id("excl"),
                userId: id("user"),
                albumMbid: id("mb"),
                expiresAt: new Date(Date.now() - 60_000),
            },
        });
        // DiscoveryTrack.trackId has no FK (design DB-5): the dangling row
        // below stays pointing at a track that never existed; only the
        // anti-join finds it, and clearing it is the check's job.
        await prisma.discoveryAlbum.create({
            data: {
                id: id("da"),
                userId: id("user"),
                rgMbid: id("rg"),
                artistName: "Orphan Artist",
                albumTitle: "Orphan Album",
                weekStartDate: new Date(),
            },
        });
        await prisma.discoveryTrack.create({
            data: {
                id: id("dt"),
                discoveryAlbumId: id("da"),
                trackId: id("gone-track"), // never existed in Track
                fileName: "01 ghost.mp3",
                filePath: "dint/ghost/01 ghost.mp3",
            },
        });

        const report = await runDataIntegrityCheck();

        expect(
            await prisma.discoverExclusion.findFirst({ where: { id: id("excl") } }),
        ).toBeNull();
        expect(
            await prisma.discoveryTrack.findFirst({ where: { id: id("dt") } }),
        ).toBeNull();
        expect(report.expiredExclusions).toBeGreaterThanOrEqual(1);
        expect(report.orphanedDiscoveryTracks).toBeGreaterThanOrEqual(1);
    });
});
