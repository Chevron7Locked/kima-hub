/**
 * The daily integrity check (and an admin's "fix tagging") moves a library album to Discover only when Discover's
 * records name exactly that album. It used to move any album whose title or artist matched any Discover record, which
 * re-filed listeners' own albums. Real test database, nothing stood in.
 */
import { prisma } from "../../utils/db";
import { relocateDiscoverAlbums } from "../discovery/discoverEvidence";
import { runDataIntegrityCheck } from "../../workers/dataIntegrity";
import { updateArtistCounts } from "../artistCountsService";

jest.setTimeout(60_000);

const P = "rda_";
const USER = `${P}user`;

/** key, artist, title, expected location after the check */
const ALBUMS = [
    // A Discover download asked for exactly this album, filed as LIBRARY with no ownership record (an older scanner).
    ["asked", "Rda Discover Artist", "Rda Asked Album", "DISCOVER"],
    // Another album by the same artist, which the listener got themselves.
    ["sameartist", "Rda Discover Artist", "Rda Own Album", "LIBRARY"],
    // Another artist's album with the same title as a Discover download.
    ["sametitle", "Rda Other Artist", "Rda Asked Album", "LIBRARY"],
    // An artist Discover once suggested (a different album, let go): their album the listener owns.
    ["oncesuggested", "Rda Suggested Artist", "Rda The Observer", "LIBRARY"],
    // A Discover download the listener liked, whose suggestion no longer matches the album's id.
    ["liked", "Rda Liked Artist", "Rda Liked Album", "LIBRARY"],
    // An album the listener's own files gave them, which Discover later suggested.
    ["alreadyhad", "Rda Owned Artist", "Rda Owned Album", "LIBRARY"],
    // A suggestion the listener let go, and their own copy of it.
    ["letgo", "Rda Let Go Artist", "Rda Let Go Album", "LIBRARY"],
    // A Discover download marked as a listener's by enrichment, not by a scan or a like: still theirs.
    ["enriched", "Rda Discover Artist", "Rda Enriched Album", "LIBRARY"],
] as const;

const location = async (key: string) => (await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb_${key}` } })).location;

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.ownedAlbum.deleteMany({ where: { rgMbid: { startsWith: P } } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    const artists = new Map<string, string>();
    for (const [key, artist, title] of ALBUMS) {
        let artistId = artists.get(artist);
        if (!artistId) {
            artistId = `${P}art_${key}`;
            artists.set(artist, artistId);
            await prisma.artist.create({ data: { id: artistId, name: artist, normalizedName: artist.toLowerCase(), identityKey: `${P}ak_${key}` } });
        }
        await prisma.album.create({
            data: { id: `${P}alb_${key}`, rgMbid: `${P}rg_${key}`, artistId, identityKey: `${P}ik_${key}`, title, primaryType: "Album", location: "LIBRARY" },
        });
    }
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 10 } });
    for (const [artist, title] of [
        ["Rda Discover Artist", "Rda Asked Album"],
        ["Rda Liked Artist", "Rda Liked Album"],
        ["Rda Discover Artist", "Rda Enriched Album"],
    ]) {
        await prisma.downloadJob.create({
            data: {
                userId: USER,
                subject: `${artist} - ${title}`,
                type: "album",
                status: "completed",
                discoveryBatchId: batch.id,
                metadata: { downloadType: "discovery", artistName: artist, albumTitle: title },
            },
        });
    }
    await prisma.discoveryAlbum.create({
        data: {
            userId: USER,
            rgMbid: `${P}rg_letgo`,
            artistName: "Rda Suggested Artist",
            albumTitle: "Rda Now We Sleep",
            weekStartDate: new Date(Date.UTC(2026, 9, 12)),
            status: "DELETED",
        },
    });
    await prisma.ownedAlbum.create({ data: { artistId: artists.get("Rda Liked Artist")!, rgMbid: `${P}rg_liked`, source: "discovery_liked" } });
    await prisma.ownedAlbum.create({ data: { artistId: artists.get("Rda Owned Artist")!, rgMbid: `${P}rg_alreadyhad`, source: "native_scan" } });
    await prisma.ownedAlbum.create({ data: { artistId: artists.get("Rda Discover Artist")!, rgMbid: `${P}rg_enriched`, source: "enrichment" } });
    for (const [artist, title, status] of [
        ["Rda Owned Artist", "Rda Owned Album", "ACTIVE"],
        ["Rda Let Go Artist", "Rda Let Go Album", "DELETED"],
    ] as const) {
        await prisma.discoveryAlbum.create({
            data: { userId: USER, rgMbid: `${P}sugg_${title}`, artistName: artist, albumTitle: title, weekStartDate: new Date(Date.UTC(2026, 9, 19)), status },
        });
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("moving library albums that came from Discover", () => {
    it("moves only the album Discover's records name exactly", async () => {
        const moved = await relocateDiscoverAlbums({ dryRun: false });
        expect(moved.filter((m) => m.artist.startsWith("Rda"))).toEqual([{ artist: "Rda Discover Artist", title: "Rda Asked Album" }]);
        for (const [key, , , expected] of ALBUMS) expect([key, await location(key)]).toEqual([key, expected]);
    });

    it("the moved album's artist counts follow it to Discover", async () => {
        const artistId = (await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb_asked` } })).artistId;
        for (const key of ["asked", "sameartist"]) {
            await prisma.track.create({
                data: { id: `${P}t_${key}`, albumId: `${P}alb_${key}`, title: key, trackNo: 1, duration: 200, filePath: `${P}${key}.flac`, fileModified: new Date(), fileSize: 1 },
            });
        }
        await updateArtistCounts(artistId);
        const counts = async () => {
            const a = await prisma.artist.findUniqueOrThrow({ where: { id: artistId } });
            return [a.libraryAlbumCount, a.discoveryAlbumCount, a.totalTrackCount];
        };
        expect(await counts()).toEqual([2, 0, 2]);

        await relocateDiscoverAlbums({ dryRun: false });

        expect(await counts()).toEqual([1, 1, 1]);
    });

    it("lists without moving on a dry run", async () => {
        const listed = await relocateDiscoverAlbums({ dryRun: true });
        expect(listed.filter((m) => m.artist.startsWith("Rda"))).toHaveLength(1);
        expect(await location("asked")).toBe("LIBRARY");
    });

    it("the daily integrity check uses the same rule", async () => {
        await runDataIntegrityCheck();
        for (const [key, , , expected] of ALBUMS) expect([key, await location(key)]).toEqual([key, expected]);
    });
});
