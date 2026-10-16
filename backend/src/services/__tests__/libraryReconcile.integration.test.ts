/**
 * Library reconcile sweep on confirmation, not a stopwatch: a track missing since an
 * EARLIER scan and still absent is retired with its cascades; a track first missed by
 * this scan waits for the next one; a mass disappearance stands the sweep down; soft
 * refs are nulled (never deleted); the audit row snapshots everything; artifact paths
 * are absolute transcode-cache paths — client device paths appear nowhere.
 */
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { reconcileDeletedTracks, transcodeArtifactPath, runReconcile } from "../libraryReconcile";
import { eventBus, type SSEEvent } from "../eventBus";

const P = "recon";
const MIN = 60_000;

async function cleanup() {
    await prisma.removalLog.deleteMany({ where: { filePath: { startsWith: `/tmp/${P}` } } });
    await prisma.playbackState.deleteMany({ where: { userId: `${P}user` } });
    await prisma.discoveryTrack.deleteMany({ where: { filePath: { startsWith: `/tmp/${P}` } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: `${P}user` } });
    await prisma.playlist.deleteMany({ where: { userId: `${P}user` } });
    await prisma.likedTrack.deleteMany({ where: { userId: `${P}user` } });
    await prisma.play.deleteMany({ where: { userId: `${P}user` } });
    await prisma.user.deleteMany({ where: { id: `${P}user` } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.genre.deleteMany({ where: { name: { startsWith: `${P}-genre` } } });
}

async function seedTrack(id: string, opts: { missingMinutesAgo?: number } = {}) {
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
            ...(opts.missingMinutesAgo !== undefined
                ? { missingSince: new Date(Date.now() - opts.missingMinutesAgo * MIN) }
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

// A scan started a minute ago; files first missed by it carry stamps newer than this.
const scanStartedAt = () => new Date(Date.now() - MIN);

beforeEach(async () => {
    await cleanup();
    await seedBase();
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("reconcileDeletedTracks", () => {

    it("hands a replaced file's plays, like and playlist place to the copy of the same song, then retires it", async () => {
        // The album was upgraded: the mp3 is gone, the flac of the same song is in.
        await prisma.track.create({
            data: { id: `${P}mp3`, albumId: `${P}alb`, title: "Schema", trackNo: 1, duration: 200, filePath: `/tmp/${P}mp3.mp3`,
                fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
        });
        await prisma.track.create({
            data: { id: `${P}flac`, albumId: `${P}alb`, title: "SCHEMA", trackNo: 1, duration: 200, filePath: `/tmp/${P}flac.flac`,
                fileModified: new Date(), fileSize: 1 },
        });
        // A different song on the same album, also gone, with no copy: retired with its history.
        await prisma.track.create({
            data: { id: `${P}solo`, albumId: `${P}alb`, title: "Other", trackNo: 2, duration: 200, filePath: `/tmp/${P}solo.mp3`,
                fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
        });
        await prisma.play.createMany({ data: [
            { userId: `${P}user`, trackId: `${P}mp3`, playedAt: new Date(Date.now() - 3 * MIN) },
            { userId: `${P}user`, trackId: `${P}mp3`, playedAt: new Date(Date.now() - 2 * MIN) },
            { userId: `${P}user`, trackId: `${P}solo`, playedAt: new Date(Date.now() - 2 * MIN) },
        ] });
        await prisma.likedTrack.create({ data: { userId: `${P}user`, trackId: `${P}mp3` } });
        await prisma.playlist.create({
            data: { id: `${P}pl`, userId: `${P}user`, name: "Recon", items: { create: [{ trackId: `${P}mp3`, rank: "a", sort: 0 }] } },
        });

        const res = await reconcileDeletedTracks(prisma, scanStartedAt());

        expect(res.removed).toBe(2);
        // The playlist's place moved to the copy: open clients are told it changed.
        expect(res.playlists.map((p) => p.playlistId)).toContain(`${P}pl`);
        expect(await prisma.track.findUnique({ where: { id: `${P}mp3` } })).toBeNull();
        expect(await prisma.play.count({ where: { trackId: `${P}flac` } })).toBe(2);
        expect(await prisma.play.count({ where: { userId: `${P}user` } })).toBe(2);
        expect(await prisma.likedTrack.findUnique({ where: { userId_trackId: { userId: `${P}user`, trackId: `${P}flac` } } })).not.toBeNull();
        expect((await prisma.playlistItem.findMany({ where: { playlistId: `${P}pl` } })).map((i) => i.trackId)).toEqual([`${P}flac`]);
        const log = await prisma.removalLog.findMany({ where: { filePath: { in: [`/tmp/${P}mp3.mp3`, `/tmp/${P}solo.mp3`] } }, orderBy: { filePath: "asc" } });
        expect(log.map((l) => l.reason)).toEqual(["replaced-by-another-file", "file-missing-confirmed"]);
    });

    it("a flag set by this scan waits for the next one", async () => {
        await seedTrack(`${P}new`, { missingMinutesAgo: 0 });
        const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));
        expect(res.removed).toBe(0);
        expect(await prisma.track.findUnique({ where: { id: `${P}new` } })).not.toBeNull();
    });

    it("an empty sweep returns 0 and touches nothing", async () => {
        const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));
        expect(res.removed).toBe(0);
        expect(await prisma.removalLog.count({ where: { filePath: { startsWith: `/tmp/${P}` } } })).toBe(0);
    });

    it("a track confirmed gone by two scans is deleted with cascades and an audit snapshot", async () => {
        await seedTrack(`${P}gone`, { missingMinutesAgo: 5 });
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

        const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));

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
        expect(log!.reason).toBe("file-missing-confirmed");
        expect(log!.artifacts).toEqual([{ table: "TranscodedFile", path: transcodeArtifactPath(`${P}gone-cache.mp3`) }]);
    });

    it("soft refs are nulled, rows preserved", async () => {
        await seedTrack(`${P}disc`, { missingMinutesAgo: 5 });
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

        await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));

        const kept = await prisma.discoveryTrack.findUnique({ where: { id: dt.id } });
        expect(kept).not.toBeNull();
        expect(kept!.trackId).toBeNull();
        expect(kept!.userKept).toBe(true);
        expect(kept!.inPlaylistCount).toBe(3);
        expect((await prisma.playbackState.findUnique({ where: { userId: `${P}user` } }))!.trackId).toBeNull();
    });

    it("a genre shared with a living track survives", async () => {
        await seedTrack(`${P}d1`, { missingMinutesAgo: 5 });
        await seedTrack(`${P}alive`);
        const g = await prisma.genre.create({ data: { id: `${P}g2`, name: `${P}-genre-shared` } });
        await prisma.trackGenre.createMany({
            data: [
                { trackId: `${P}d1`, genreId: g.id },
                { trackId: `${P}alive`, genreId: g.id },
            ],
        });
        await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));
        expect(await prisma.genre.findUnique({ where: { id: g.id } })).not.toBeNull();
    });

    it("a mass disappearance stands the sweep down and touches nothing", async () => {
        // past both guards' tripwires: >= 10 tracks and > 10% of the library gone at once
        const alive = Array.from({ length: 80 }, (_, i) => `${P}a${i}`);
        await prisma.track.createMany({
            data: alive.map((id) => ({
                id, albumId: `${P}alb`, title: `${id}`, trackNo: 1, duration: 200,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1,
            })),
        });
        const gone = Array.from({ length: 10 }, (_, i) => `${P}m${i}`);
        await prisma.track.createMany({
            data: gone.map((id) => ({
                id, albumId: `${P}alb`, title: `${id}`, trackNo: 1, duration: 200,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1,
                missingSince: new Date(Date.now() - 5 * MIN),
            })),
        });

        const res = await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));
        expect(res.removed).toBe(0);
        for (const id of gone) {
            expect(await prisma.track.findUnique({ where: { id } })).not.toBeNull();
        }
        expect(await prisma.removalLog.count({ where: { filePath: { startsWith: `/tmp/${P}m` } } })).toBe(0);
    });

    it("artifact paths are absolute under the transcode cache root", () => {
        const abs = transcodeArtifactPath("abc.mp3");
        expect(abs.endsWith("abc.mp3")).toBe(true);
        expect(abs.startsWith("/")).toBe(true);
    });

    it("flag mode skips the sweep without touching tracks", async () => {
        await seedTrack(`${P}flag`, { missingMinutesAgo: 999 });
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "flag" });
        const res = await runReconcile(scanStartedAt());
        spy.mockRestore();
        expect(res).toEqual({ removed: 0, artifacts: [], playlists: [], skipped: true });
        expect(await prisma.track.findUnique({ where: { id: `${P}flag` } })).not.toBeNull();
        expect(await prisma.removalLog.count({ where: { filePath: `/tmp/${P}flag.flac` } })).toBe(0);
    });

    it("delete mode sweeps confirmed-gone tracks through runReconcile", async () => {
        await seedTrack(`${P}swp`, { missingMinutesAgo: 5 });
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({
            ...config.music,
            reconcileMode: "delete",
        });
        try {
            const res = await runReconcile(scanStartedAt());
            expect(res.skipped).toBe(false);
            expect(res.removed).toBe(1);
            expect(await prisma.track.findUnique({ where: { id: `${P}swp` } })).toBeNull();
            expect(await prisma.removalLog.count({ where: { filePath: `/tmp/${P}swp.flac` } })).toBe(1);
        } finally {
            spy.mockRestore();
        }
    });

    it("a playlist that held a retired song: its owner is told once, after the sweep commits", async () => {
        await seedTrack(`${P}held`, { missingMinutesAgo: 5 });
        const list = await prisma.playlist.create({
            data: { userId: `${P}user`, name: `${P}list`, items: { create: [{ trackId: `${P}held`, sort: 0, rank: "a" }] } },
        });
        const heard: SSEEvent[] = [];
        const stop = eventBus.subscribe(`${P}user`, { send: (event) => (heard.push(event), true) });
        const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
        try {
            const inside = await prisma.$transaction(async (tx) => {
                const res = await reconcileDeletedTracks(tx, scanStartedAt());
                expect(heard).toEqual([]);
                return res;
            });
            expect(inside.playlists).toEqual([{ userId: `${P}user`, playlistId: list.id }]);
            expect(heard).toEqual([]);

            await seedTrack(`${P}held2`, { missingMinutesAgo: 5 });
            await prisma.playlistItem.create({ data: { playlistId: list.id, trackId: `${P}held2`, sort: 1, rank: "b" } });
            await runReconcile(scanStartedAt());
            expect(heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload)).toEqual([
                { playlistId: list.id, deleted: false },
            ]);
            expect(await prisma.playlistItem.count({ where: { playlistId: list.id } })).toBe(0);
        } finally {
            spy.mockRestore();
            stop();
            await prisma.playlist.deleteMany({ where: { id: list.id } });
        }
    });
});
