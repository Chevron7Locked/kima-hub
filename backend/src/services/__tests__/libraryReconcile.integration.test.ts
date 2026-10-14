/**
 * Library reconcile sweep: grace-crossed missing tracks are retired with their cascades,
 * soft refs are nulled (never deleted), the audit row snapshots everything, and artifact
 * paths are absolute transcode-cache paths — client device paths appear nowhere.
 */
import { prisma } from "../../utils/db";
import { reconcileDeletedTracks, transcodeArtifactPath } from "../libraryReconcile";

const P = "recon";
const DAY = 86_400_000;

async function cleanup() {
    await prisma.removalLog.deleteMany({ where: { filePath: { startsWith: `/tmp/${P}` } } });
    await prisma.playbackState.deleteMany({ where: { userId: `${P}user` } });
    await prisma.discoveryTrack.deleteMany({ where: { filePath: { startsWith: `/tmp/${P}` } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: `${P}user` } });
    await prisma.likedTrack.deleteMany({ where: { userId: `${P}user` } });
    await prisma.play.deleteMany({ where: { userId: `${P}user` } });
    await prisma.user.deleteMany({ where: { id: `${P}user` } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.genre.deleteMany({ where: { name: { startsWith: `${P}-genre` } } });
}

async function seedTrack(id: string, opts: { missingDaysAgo?: number } = {}) {
    await prisma.track.create({
        data: {
            id,
            albumId: `${P}alb`,
            title: `${id} title`,
            trackNo: 1,
            duration: 200,
            filePath: `/tmp/${id}.flac`,
            fileModified: new Date(),
            fileSize: 1,
            ...(opts.missingDaysAgo !== undefined
                ? { missingSince: new Date(Date.now() - opts.missingDaysAgo * DAY) }
                : {}),
        },
    });
}

async function seedBase() {
    await prisma.user.create({
        data: { id: `${P}user`, username: `${P}user`, passwordHash: "x", role: "user", tokenVersion: 0 },
    });
    await prisma.artist.create({ data: { id: `${P}art`, name: "Recon Artist", identityKey: `${P}-a` } });
    await prisma.album.create({
        data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Recon Album", primaryType: "Album" },
    });
    await prisma.discoveryAlbum.create({
        data: {
            id: `${P}dalb`, userId: `${P}user`, rgMbid: `${P}-drg`, artistName: "Recon Artist",
            albumTitle: "Recon Album", weekStartDate: new Date(),
        },
    });
}

beforeEach(async () => {
    await cleanup();
    await seedBase();
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("reconcileDeletedTracks", () => {

    it("young flag within grace is kept", async () => {
        await seedTrack(`${P}young`, { missingDaysAgo: 5 });
        const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, new Date(Date.now() - 30 * DAY)));
        expect(res.removed).toBe(0);
        expect(await prisma.track.findUnique({ where: { id: `${P}young` } })).not.toBeNull();
    });

    it("empty sweep returns 0 and touches nothing", async () => {
        const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, new Date(Date.now() - 30 * DAY)));
        expect(res.removed).toBe(0);
        expect(await prisma.removalLog.count({ where: { filePath: { startsWith: `/tmp/${P}` } } })).toBe(0);
    });

    it("grace-crossed track is deleted with cascades and an audit snapshot", async () => {
        await seedTrack(`${P}gone`, { missingDaysAgo: 45 });
        await prisma.play.create({ data: { userId: `${P}user`, trackId: `${P}gone` } });
        await prisma.likedTrack.create({ data: { userId: `${P}user`, trackId: `${P}gone` } });
        const genre = await prisma.genre.create({ data: { id: `${P}g1`, name: `${P}-genre-only` } });
        await prisma.trackGenre.create({ data: { trackId: `${P}gone`, genreId: genre.id } });
        await prisma.transcodedFile.create({
            data: {
                trackId: `${P}gone`, quality: "high", cachePath: `${P}gone-cache.mp3`,
                cacheSize: 123n, sourceModified: new Date(),
            },
        });

        const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, new Date(Date.now() - 30 * DAY)));

        expect(res.removed).toBe(1);
        expect(await prisma.track.findUnique({ where: { id: `${P}gone` } })).toBeNull();
        expect(await prisma.play.count({ where: { trackId: `${P}gone` } })).toBe(0);
        expect(await prisma.likedTrack.count({ where: { trackId: `${P}gone` } })).toBe(0);
        expect(await prisma.transcodedFile.count({ where: { trackId: `${P}gone` } })).toBe(0);
        expect(await prisma.genre.findUnique({ where: { id: genre.id } })).toBeNull();

        const log = await prisma.removalLog.findFirst({ where: { filePath: `/tmp/${P}gone.flac` } });
        expect(log).not.toBeNull();
        expect(log!.title).toBe(`${P}gone title`);
        expect(log!.artistName).toBe("Recon Artist");
        expect(log!.albumTitle).toBe("Recon Album");
        expect(log!.reason).toBe("file-missing-grace");
        expect(log!.artifacts).toEqual([{ table: "TranscodedFile", path: transcodeArtifactPath(`${P}gone-cache.mp3`) }]);
    });

    it("soft refs are nulled, rows preserved", async () => {
        await seedTrack(`${P}disc`, { missingDaysAgo: 45 });
        const dt = await prisma.discoveryTrack.create({
            data: {
                discoveryAlbumId: `${P}dalb`, trackId: `${P}disc`,
                fileName: "x.flac", filePath: `/tmp/${P}-disc.flac`,
                inPlaylistCount: 3, userKept: true,
            },
        });
        await prisma.playbackState.create({
            data: { userId: `${P}user`, trackId: `${P}disc`, playbackType: "library" },
        });

        await prisma.$transaction((tx) => reconcileDeletedTracks(tx, new Date(Date.now() - 30 * DAY)));

        const kept = await prisma.discoveryTrack.findUnique({ where: { id: dt.id } });
        expect(kept).not.toBeNull();
        expect(kept!.trackId).toBeNull();
        expect(kept!.userKept).toBe(true);
        expect(kept!.inPlaylistCount).toBe(3);
        expect((await prisma.playbackState.findUnique({ where: { userId: `${P}user` } }))!.trackId).toBeNull();
    });

    it("a genre shared with a living track survives", async () => {
        await seedTrack(`${P}d1`, { missingDaysAgo: 45 });
        await seedTrack(`${P}alive`);
        const g = await prisma.genre.create({ data: { id: `${P}g2`, name: `${P}-genre-shared` } });
        await prisma.trackGenre.createMany({
            data: [
                { trackId: `${P}d1`, genreId: g.id },
                { trackId: `${P}alive`, genreId: g.id },
            ],
        });
        await prisma.$transaction((tx) => reconcileDeletedTracks(tx, new Date(Date.now() - 30 * DAY)));
        expect(await prisma.genre.findUnique({ where: { id: g.id } })).not.toBeNull();
    });

    it("artifact paths are absolute under the transcode cache root", () => {
        const abs = transcodeArtifactPath("abc.mp3");
        expect(abs.endsWith("abc.mp3")).toBe(true);
        expect(abs.startsWith("/")).toBe(true);
    });
});
