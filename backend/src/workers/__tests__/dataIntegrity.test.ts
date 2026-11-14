/**
 * The integrity check deletes only what a scan or re-discovery recreates
 * (expired exclusions, orphaned DiscoveryTrack rows, old notifications) and
 * only reports rows that carry a decision: orphaned DISCOVER albums, ghost
 * albums and orphaned OwnedAlbum keeps. Real database, no prisma mock.
 */

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";

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

    describe("a suggestion with the same artist name and title", () => {
        const ARTIST = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
        const NAMESAKE = "9c9f1380-2016-4671-bd33-fe2d94d1ed44";

        /** A DISCOVER album by artist id `held`, and a suggestion of the same name and title for artist id `suggested`. */
        async function seed(suggested: string | null, held: string | null) {
            await prisma.user.create({ data: { id: id("user9"), username: id("user9"), passwordHash: "x" } });
            await prisma.artist.create({ data: { id: id("art9"), name: "Twin Namesake", identityKey: id("k9"), mbid: held } });
            await prisma.discoveryAlbum.create({
                data: {
                    id: id("da9"),
                    userId: id("user9"),
                    rgMbid: id("rg-suggested9"),
                    artistName: "Twin Namesake",
                    artistMbid: suggested,
                    albumTitle: "Shared Title",
                    weekStartDate: new Date(),
                },
            });
            await prisma.album.create({
                data: { id: id("alb9"), rgMbid: id("rg-scanned9"), artistId: id("art9"), identityKey: id("ik9"), title: "Shared Title", primaryType: "Album", location: "DISCOVER" },
            });
            await prisma.track.create({
                data: { id: id("t9"), albumId: id("alb9"), title: "x", trackNo: 1, duration: 1, filePath: "/tmp/dint9.flac", fileModified: new Date(), fileSize: 1 },
            });
        }

        async function orphanWarned(): Promise<boolean> {
            const warn = jest.spyOn(logger, "warn");
            try {
                await runDataIntegrityCheck();
                return warn.mock.calls.some((c) => String(c[0]).includes("Orphaned album") && String(c[0]).includes("Shared Title"));
            } finally {
                warn.mockRestore();
            }
        }

        it("does not cover another artist's album under another MusicBrainz id", async () => {
            await seed(ARTIST, NAMESAKE);
            expect(await orphanWarned()).toBe(true);
        });

        it.each([
            ["the same id", ARTIST, ARTIST],
            ["the suggestion has no id", null, NAMESAKE],
            ["the suggestion's id is a placeholder", "temp-1793617784650-0.5", NAMESAKE],
            ["the album's artist has no id", ARTIST, null],
        ])("covers the album by name when %s", async (_what, suggested, held) => {
            await seed(suggested, held);
            expect(await orphanWarned()).toBe(false);
        });
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
    it("moves the library-changed marker when a temp artist's listed albums merge into the real artist, and not for a Discover album or one with no playable song", async () => {
        const make = async (key: string, location: "LIBRARY" | "DISCOVER", missing = false) => {
            await prisma.artist.create({ data: { id: id(`${key}_real`), name: `Dint ${key}`, normalizedName: `dint ${key}`, mbid: `0000aaaa-0000-4000-8000-00000000000${{ lib: 1, dis: 2, gone: 3 }[key]}`, identityKey: id(`${key}_rk`) } });
            await prisma.artist.create({ data: { id: id(`${key}_temp`), name: `Dint ${key}`, normalizedName: `dint ${key}`, mbid: `temp-dint-${key}`, identityKey: id(`${key}_tk`) } });
            await prisma.album.create({
                data: { id: id(`${key}_alb`), rgMbid: id(`${key}_rg`), artistId: id(`${key}_temp`), identityKey: id(`${key}_ak`), title: `Dint ${key} Album`, primaryType: "Album", location },
            });
            await prisma.track.create({
                data: { id: id(`${key}_t`), albumId: id(`${key}_alb`), title: "x", trackNo: 1, duration: 1, filePath: `/tmp/dint_${key}.flac`, fileModified: new Date(), fileSize: 1, ...(missing ? { missingSince: new Date() } : {}) },
            });
        };
        await make("dis", "DISCOVER");
        expect(await markerMoves(() => runDataIntegrityCheck())).toBe(false);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: id("dis_alb") } })).artistId).toBe(id("dis_real"));

        await make("gone", "LIBRARY", true);
        expect(await markerMoves(() => runDataIntegrityCheck())).toBe(false);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: id("gone_alb") } })).artistId).toBe(id("gone_real"));

        await make("lib", "LIBRARY");
        expect(await markerMoves(() => runDataIntegrityCheck())).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: id("lib_alb") } })).artistId).toBe(id("lib_real"));
    });
});
