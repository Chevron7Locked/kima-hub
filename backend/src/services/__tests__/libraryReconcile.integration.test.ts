/**
 * Library reconcile sweep on confirmation, not a stopwatch: a track missing since an
 * EARLIER scan and still absent is retired with its cascades; a track first missed by
 * this scan waits for the next one; a mass disappearance stands the sweep down; soft
 * refs are nulled (never deleted); the audit row snapshots everything; artifact paths
 * are absolute transcode-cache paths — client device paths appear nowhere.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { reconcileDeletedTracks, transcodeArtifactPath, runReconcile } from "../libraryReconcile";
import { eventBus, type SSEEvent } from "../eventBus";
import { lockPlayHistory, recordPlay } from "../playRecording";
import * as stageRecords from "../stages/stageRecords";
import { logger } from "../../utils/logger";

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

    it("moves every playlist entry of a replaced file to the copy, repeats and entries beside the copy's own included", async () => {
        await prisma.track.create({
            data: { id: `${P}mp3`, albumId: `${P}alb`, title: "Schema", trackNo: 1, duration: 200, filePath: `/tmp/${P}mp3.mp3`,
                fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
        });
        await prisma.track.create({
            data: { id: `${P}flac`, albumId: `${P}alb`, title: "Schema", trackNo: 1, duration: 200, filePath: `/tmp/${P}flac.flac`,
                fileModified: new Date(), fileSize: 1 },
        });
        await prisma.track.create({
            data: { id: `${P}other`, albumId: `${P}alb`, title: "Other", trackNo: 2, duration: 200, filePath: `/tmp/${P}other.flac`,
                fileModified: new Date(), fileSize: 1 },
        });
        await prisma.playlist.create({
            data: {
                id: `${P}pl`, userId: `${P}user`, name: "Recon",
                items: { create: [
                    { trackId: `${P}mp3`, rank: "a", sort: 0 }, { trackId: `${P}other`, rank: "b", sort: 1 },
                    { trackId: `${P}mp3`, rank: "c", sort: 2 }, { trackId: `${P}flac`, rank: "d", sort: 3 },
                ] },
            },
        });

        await reconcileDeletedTracks(prisma, scanStartedAt());

        const held = await prisma.playlistItem.findMany({ where: { playlistId: `${P}pl` }, orderBy: { rank: "asc" } });
        expect(held.map((i) => i.trackId)).toEqual([`${P}flac`, `${P}other`, `${P}flac`, `${P}flac`]);
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
                fileName: "x.flac", filePath: `/tmp/${P}-disc.flac`, lastPlayedAt: new Date("2026-10-01T00:00:00Z"),
            },
        });
        await prisma.playbackState.create({
            data: { userId: `${P}user`, trackId: `${P}disc`, playbackType: "library" },
        });

        await prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));

        const kept = await prisma.discoveryTrack.findUnique({ where: { id: dt.id } });
        expect(kept).not.toBeNull();
        expect(kept!.trackId).toBeNull();
        expect(kept!.lastPlayedAt).toEqual(new Date("2026-10-01T00:00:00Z"));
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

    describe("moving plays to the copy of a replaced song", () => {
        const OTHER = `${P}user2`;

        async function seedReplacedSongPlayedBy(...users: string[]) {
            await prisma.track.create({
                data: { id: `${P}mp3`, albumId: `${P}alb`, title: "Schema", trackNo: 1, duration: 200, filePath: `/tmp/${P}mp3.mp3`,
                    fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
            });
            await prisma.track.create({
                data: { id: `${P}flac`, albumId: `${P}alb`, title: "Schema", trackNo: 1, duration: 200, filePath: `/tmp/${P}flac.flac`,
                    fileModified: new Date(), fileSize: 1 },
            });
            for (const userId of users) {
                if (userId === OTHER) {
                    await prisma.user.create({ data: { id: OTHER, username: OTHER, passwordHash: "x", role: "user", tokenVersion: 0 } });
                }
                await prisma.play.create({ data: { userId, trackId: `${P}mp3`, playedAt: new Date(Date.now() - 3 * MIN) } });
            }
        }

        /** Holds one listener's play history exclusively, as the false-start repair does, until `release` is called. */
        async function repairHolding(userId: string) {
            let release!: () => void;
            const released = new Promise<void>((resolve) => (release = resolve));
            let locked!: () => void;
            const holding = new Promise<void>((resolve) => (locked = resolve));
            const done = prisma.$transaction(async (tx) => {
                await lockPlayHistory(tx, userId, { exclusive: true });
                locked();
                await released;
            }, { timeout: 30_000 });
            await holding;
            return { release, done };
        }

        afterEach(async () => {
            await prisma.play.deleteMany({ where: { userId: OTHER } });
            await prisma.user.deleteMany({ where: { id: OTHER } });
        });

        async function seedSecondReplacedSong(playedBy: string) {
            await prisma.track.create({
                data: { id: `${P}mp3b`, albumId: `${P}alb`, title: "Second", trackNo: 2, duration: 200, filePath: `/tmp/${P}mp3b.mp3`,
                    fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
            });
            await prisma.track.create({
                data: { id: `${P}flacb`, albumId: `${P}alb`, title: "Second", trackNo: 2, duration: 200, filePath: `/tmp/${P}flacb.flac`,
                    fileModified: new Date(), fileSize: 1 },
            });
            await prisma.play.create({ data: { userId: playedBy, trackId: `${P}mp3b`, playedAt: new Date(Date.now() - 3 * MIN) } });
        }

        it("never waits for a repair of that listener's history: the song stays as it is for the next sweep, the rest retire now", async () => {
            await seedReplacedSongPlayedBy(`${P}user`);
            await prisma.user.create({ data: { id: OTHER, username: OTHER, passwordHash: "x", role: "user", tokenVersion: 0 } });
            await seedSecondReplacedSong(OTHER);
            const repair = await repairHolding(`${P}user`);
            const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
            try {
                const started = Date.now();
                const res = await runReconcile(scanStartedAt());
                expect(Date.now() - started).toBeLessThan(5_000);

                // The song whose listener is being repaired is untouched: still there, its play still on it.
                expect(res.removed).toBe(1);
                expect(await prisma.track.findUnique({ where: { id: `${P}mp3` } })).not.toBeNull();
                expect(await prisma.play.count({ where: { trackId: `${P}mp3` } })).toBe(1);
                expect(await prisma.play.count({ where: { trackId: `${P}flac` } })).toBe(0);
                expect(await prisma.removalLog.count({ where: { filePath: `/tmp/${P}mp3.mp3` } })).toBe(0);
                // The rest carried on.
                expect(await prisma.track.findUnique({ where: { id: `${P}mp3b` } })).toBeNull();
                expect(await prisma.play.count({ where: { trackId: `${P}flacb` } })).toBe(1);

                repair.release();
                await repair.done;
                const next = await runReconcile(scanStartedAt());
                expect(next.removed).toBe(1);
                expect(await prisma.track.findUnique({ where: { id: `${P}mp3` } })).toBeNull();
                expect(await prisma.play.count({ where: { trackId: `${P}flac` } })).toBe(1);
            } finally {
                repair.release();
                spy.mockRestore();
            }
        });

        it("leaves a song alone when any one of its listeners is busy: none of its plays moves", async () => {
            await seedReplacedSongPlayedBy(`${P}user`, OTHER);
            const repair = await repairHolding(OTHER);
            const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
            try {
                expect((await runReconcile(scanStartedAt())).removed).toBe(0);
                expect(await prisma.play.count({ where: { trackId: `${P}mp3` } })).toBe(2);
                expect(await prisma.play.count({ where: { trackId: `${P}flac` } })).toBe(0);
                expect(await prisma.track.findUnique({ where: { id: `${P}mp3` } })).not.toBeNull();
            } finally {
                repair.release();
                await repair.done;
                spy.mockRestore();
            }
        });

        it("is not held up by a repair of a listener whose plays it does not move", async () => {
            await seedReplacedSongPlayedBy(`${P}user`);
            await prisma.user.create({ data: { id: OTHER, username: OTHER, passwordHash: "x", role: "user", tokenVersion: 0 } });
            const repair = await repairHolding(OTHER);
            const spy = jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "delete" });
            try {
                expect((await runReconcile(scanStartedAt())).removed).toBe(1);
            } finally {
                repair.release();
                await repair.done;
                spy.mockRestore();
            }
        });
    });

    it("a song a scan found again while the sweep was under way stays", async () => {
        await seedTrack(`${P}back`, { missingMinutesAgo: 5 });
        await seedTrack(`${P}still`, { missingMinutesAgo: 5 });
        // The scan clears the flag (and commits) after the sweep has read its list and before it holds the rows.
        const foundAgain = (tx: Prisma.TransactionClient) => new Proxy(tx, {
            get(target, key) {
                const value = (target as any)[key];
                if (key !== "track") return typeof value === "function" ? value.bind(target) : value;
                return new Proxy(value, {
                    get(model, method) {
                        const fn = model[method];
                        if (method !== "findMany") return typeof fn === "function" ? fn.bind(model) : fn;
                        return async (...args: unknown[]) => {
                            const rows = await fn.apply(model, args);
                            await prisma.track.update({ where: { id: `${P}back` }, data: { missingSince: null } });
                            return rows;
                        };
                    },
                });
            },
        }) as Prisma.TransactionClient;

        await prisma.$transaction((tx) => reconcileDeletedTracks(foundAgain(tx), scanStartedAt()));
        expect(await prisma.track.findUnique({ where: { id: `${P}back` } })).not.toBeNull();
        expect(await prisma.track.findUnique({ where: { id: `${P}still` } })).toBeNull();
    });

    describe("a song another job is holding", () => {
        // Another job's transaction holds a lock while the sweep runs; it is released when `during` is done.
        async function whileHeld(lock: (tx: Prisma.TransactionClient) => Promise<unknown>, during: () => Promise<void>) {
            let release!: () => void;
            const held = new Promise<void>((resolve) => { release = resolve; });
            let locked!: () => void;
            const ready = new Promise<void>((resolve) => { locked = resolve; });
            const holder = prisma.$transaction(async (tx) => { await lock(tx); locked(); await held; }, { timeout: 30_000 });
            await ready;
            try {
                await during();
            } finally {
                release();
                await holder;
            }
        }
        const sweep = () => prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));

        it("a song whose stage records another job holds is left for the next sweep, never waited for", async () => {
            await seedTrack(`${P}busy`, { missingMinutesAgo: 5 });
            await seedTrack(`${P}free`, { missingMinutesAgo: 5 });
            await prisma.trackStage.createMany({ data: [
                { trackId: `${P}busy`, stage: "recording" }, { trackId: `${P}busy`, stage: "analysis" },
                { trackId: `${P}free`, stage: "recording" },
            ] });
            await whileHeld(
                (tx) => tx.$queryRaw`SELECT id FROM "TrackStage" WHERE "trackId" = ${`${P}busy`} AND stage = 'analysis' FOR UPDATE`,
                async () => {
                    const started = Date.now();
                    await expect(sweep()).resolves.toMatchObject({ removed: 1 });
                    expect(Date.now() - started).toBeLessThan(3000);
                },
            );
            expect(await prisma.track.findUnique({ where: { id: `${P}busy` } })).not.toBeNull();
            expect(await prisma.trackStage.count({ where: { trackId: `${P}busy` } })).toBe(2);
            expect(await prisma.track.findUnique({ where: { id: `${P}free` } })).toBeNull();
            // Once the job has let go, the next sweep takes the song.
            await expect(sweep()).resolves.toMatchObject({ removed: 1 });
            expect(await prisma.track.findUnique({ where: { id: `${P}busy` } })).toBeNull();
        });

        it("a song whose row another job holds is left for the next sweep, never waited for", async () => {
            await seedTrack(`${P}rowbusy`, { missingMinutesAgo: 5 });
            await seedTrack(`${P}rowfree`, { missingMinutesAgo: 5 });
            await whileHeld(
                // What the stage module's mirror of a song's status does to its row.
                (tx) => tx.$queryRaw`SELECT id FROM "Track" WHERE id = ${`${P}rowbusy`} FOR NO KEY UPDATE`,
                async () => {
                    const started = Date.now();
                    await expect(sweep()).resolves.toMatchObject({ removed: 1 });
                    expect(Date.now() - started).toBeLessThan(3000);
                },
            );
            expect(await prisma.track.findUnique({ where: { id: `${P}rowbusy` } })).not.toBeNull();
            expect(await prisma.track.findUnique({ where: { id: `${P}rowfree` } })).toBeNull();
            await expect(sweep()).resolves.toMatchObject({ removed: 1 });
            expect(await prisma.track.findUnique({ where: { id: `${P}rowbusy` } })).toBeNull();
        });
    });

    describe("beside the scan's own moves on the same songs", () => {
        afterEach(() => jest.restoreAllMocks());

        it("sweeps, flags and returns songs at the same time without anyone losing a deadlock, waiting, or failing", async () => {
            const warned = jest.spyOn(logger, "warn");
            const sweep = () => prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()), { timeout: 30_000 });
            for (let round = 0; round < 6; round++) {
                const ids = Array.from({ length: 25 }, (_, i) => `${P}c${round}x${i}`);
                for (const id of ids) {
                    await seedTrack(id, { missingMinutesAgo: 5 });
                    await prisma.trackStage.createMany({ data: [
                        { trackId: id, stage: "recording" }, { trackId: id, stage: "analysis" }, { trackId: id, stage: "fingerprint" },
                    ] });
                }
                const first = ids.slice(0, 15);
                const second = ids.slice(10);
                const started = Date.now();
                await Promise.all([
                    sweep(),
                    stageRecords.flagMissingFiles(first),
                    stageRecords.returnFiles(second),
                    sweep(),
                    stageRecords.flagMissingFiles(second),
                    stageRecords.returnFiles(first),
                ]);
                expect(Date.now() - started).toBeLessThan(15_000);
            }
            // Whatever order they ran in, each song is whole: deleted with its records, or there with them.
            const songs = await prisma.track.findMany({ where: { id: { startsWith: `${P}c` } }, select: { id: true } });
            for (const { id } of songs) expect(await prisma.trackStage.count({ where: { trackId: id } })).toBe(3);
            expect(warned).not.toHaveBeenCalledWith(expect.stringMatching(/lost a transaction conflict/));
        }, 120_000);
    });

    describe("a drive's worth of songs", () => {
        // A statement takes at most 32767 bind parameters: a sweep that retires more songs than that passes its id lists
        // as arrays. The library is built inside a transaction that is rolled back, so no other test ever sees it.
        const RETIRING = 32_800;
        const LIVE = 300_000;
        class Rollback extends Error {}

        it("retires more songs than a statement has bind parameters", async () => {
            let outcome: Awaited<ReturnType<typeof reconcileDeletedTracks>> | undefined;
            let left = -1;
            let logged = -1;
            await expect(
                prisma.$transaction(async (tx) => {
                    await tx.$executeRaw`
                        INSERT INTO "Album" (id, "artistId", "rgMbid", "identityKey", title, "primaryType")
                        SELECT 'reconbig' || n, 'reconart', 'reconbigrg' || n, 'reconbigak' || n, 'Big ' || n, 'Album'
                          FROM generate_series(0, 399) n`;
                    await tx.$executeRaw`
                        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", "missingSince", "moodTags", "essentiaGenres", "updatedAt")
                        SELECT 'reconbigt' || i, 'reconbig' || (i % 400), 'song ' || i, i / 400 + 1, 200,
                               '/tmp/reconbigt' || i || '.flac', now(), 1,
                               CASE WHEN i < ${RETIRING} THEN now() - interval '5 minutes' END, '{}'::text[], '{}'::text[], now()
                          FROM generate_series(0, ${RETIRING + LIVE - 1}) i`;
                    // The planner knows the size of the library, as it does of a real one (without this it plans for the
                    // handful of rows other tests left, and a join over 300 thousand rows runs for minutes).
                    await tx.$executeRaw`ANALYZE "Track"`;
                    outcome = await reconcileDeletedTracks(tx, scanStartedAt());
                    left = await tx.track.count({ where: { id: { startsWith: `${P}bigt` } } });
                    logged = await tx.removalLog.count({ where: { filePath: { startsWith: `/tmp/${P}bigt` } } });
                    throw new Rollback();
                }, { timeout: 170_000, maxWait: 30_000 }),
            ).rejects.toBeInstanceOf(Rollback);
            expect(outcome!.removed).toBe(RETIRING);
            expect(left).toBe(LIVE);
            expect(logged).toBe(RETIRING);
            expect(await prisma.track.count({ where: { id: { startsWith: `${P}bigt` } } })).toBe(0);
        }, 180_000);
    });

    it("a play reported for a retiring song while the sweep is under way is refused, never recorded and lost", async () => {
        const LATE = `${P}late`;
        await prisma.user.create({ data: { id: LATE, username: LATE, passwordHash: "x", role: "user", tokenVersion: 0 } });
        await prisma.track.create({
            data: { id: `${P}mp3`, albumId: `${P}alb`, title: "Schema", trackNo: 1, duration: 200, filePath: `/tmp/${P}mp3.mp3`,
                fileModified: new Date(), fileSize: 1, missingSince: new Date(Date.now() - 5 * MIN) },
        });
        await prisma.track.create({
            data: { id: `${P}flac`, albumId: `${P}alb`, title: "Schema", trackNo: 1, duration: 200, filePath: `/tmp/${P}flac.flac`,
                fileModified: new Date(), fileSize: 1 },
        });
        await prisma.play.create({ data: { userId: `${P}user`, trackId: `${P}mp3`, playedAt: new Date(Date.now() - 3 * MIN) } });

        // A listener with no history on the song reports a play (the app was offline, say) after the sweep has moved the
        // existing plays and just before it deletes the song.
        let report: ReturnType<typeof recordPlay> | undefined;
        const midSweep = (tx: Prisma.TransactionClient) => new Proxy(tx, {
            get(target, key) {
                const value = (target as any)[key];
                if (key !== "$executeRaw") return typeof value === "function" ? value.bind(target) : value;
                // The statement that deletes the songs is the last thing the sweep does before it commits.
                return async (strings: TemplateStringsArray, ...values: unknown[]) => {
                    if (strings.join("?").includes('DELETE FROM "Track"')) {
                        report = recordPlay({ userId: LATE, trackId: `${P}mp3`, clientAttestedComplete: true });
                        await new Promise((resolve) => setTimeout(resolve, 500));
                    }
                    return value.call(target, strings, ...values);
                };
            },
        }) as Prisma.TransactionClient;

        try {
            await prisma.$transaction((tx) => reconcileDeletedTracks(midSweep(tx), scanStartedAt()));
            // The hook fired, so the report really was made mid-sweep.
            expect(report).toBeDefined();
            const outcome = await report!;

            expect(await prisma.track.findUnique({ where: { id: `${P}mp3` } })).toBeNull();
            // The play waited on the song's row, found the song gone once the sweep committed, and was refused: nothing
            // was written, and the caller was told so (it was not told "recorded" and then lost to the cascade).
            expect(outcome).toEqual({ recorded: false, reason: "unknown-track" });
            expect(await prisma.play.count({ where: { userId: LATE } })).toBe(0);
            expect(await prisma.play.count({ where: { userId: `${P}user`, trackId: `${P}flac` } })).toBe(1);
        } finally {
            await prisma.play.deleteMany({ where: { userId: LATE } });
            await prisma.user.deleteMany({ where: { id: LATE } });
        }
    });

    describe("saved queues", () => {
        const entry = (id: string) => ({ id, title: `${id} title`, displayTitle: null, duration: 200, artist: null, album: null });
        const OTHER_Q = `${P}user3`;

        async function seedQueue(userId: string, ids: string[], currentIndex: number, extra: { queueSource?: string; position?: number; changedBy?: string } = {}) {
            const data = { trackId: ids[currentIndex] ?? null, queue: ids.map(entry), currentIndex, queueSource: extra.queueSource ?? null, position: extra.position ?? 0, changedBy: extra.changedBy ?? null };
            await prisma.playbackState.upsert({ where: { userId }, create: { userId, playbackType: "track", ...data }, update: data });
        }
        async function savedQueue(userId: string) {
            const row = await prisma.playbackState.findUnique({ where: { userId } });
            return { ids: (row!.queue as Array<{ id: string }> | null)?.map((e) => e.id) ?? null, index: row!.currentIndex, row: row! };
        }

        beforeEach(async () => {
            for (const id of ["a", "b", "c", "d", "e"]) await seedTrack(`${P}q${id}`, ["b", "d"].includes(id) ? { missingMinutesAgo: 5 } : {});
        });
        afterEach(async () => {
            await prisma.playbackState.deleteMany({ where: { userId: OTHER_Q } });
            await prisma.user.deleteMany({ where: { id: OTHER_Q } });
        });

        const sweep = () => prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));
        const q = (...letters: string[]) => letters.map((l) => `${P}q${l}`);

        it("drops retired songs from the queue and keeps the index on the same song", async () => {
            await seedQueue(`${P}user`, q("a", "b", "c", "d", "e"), 4, { queueSource: "album:x" });
            await sweep();
            const saved = await savedQueue(`${P}user`);
            expect(saved.ids).toEqual(q("a", "c", "e"));
            expect(saved.index).toBe(2);
            expect(saved.ids![saved.index]).toBe(`${P}qe`);
            // Every entry still came from the page that started the queue.
            expect(saved.row.queueSource).toBe("album:x");
        });

        it("points at the next remaining song when the current one was dropped", async () => {
            await seedQueue(`${P}user`, q("a", "b", "c", "d", "e"), 1, { position: 4000 });
            await sweep();
            const saved = await savedQueue(`${P}user`);
            expect(saved.ids).toEqual(q("a", "c", "e"));
            expect(saved.ids![saved.index]).toBe(`${P}qc`);
            // The track the state names follows the index to the song now current.
            expect(saved.row.trackId).toBe(`${P}qc`);
            // The offset into a song that is gone means nothing for the next one.
            expect(saved.row.position).toBe(0);
        });

        it("points at the last remaining song when the current one was dropped at the end", async () => {
            await seedQueue(`${P}user`, q("a", "c", "d"), 2);
            await sweep();
            const saved = await savedQueue(`${P}user`);
            expect(saved.ids).toEqual(q("a", "c"));
            expect(saved.index).toBe(1);
        });

        it("empties the queue, its source and its index when every song in it was retired", async () => {
            await seedQueue(`${P}user`, q("b", "d"), 1, { queueSource: "album:x", position: 500 });
            await sweep();
            const saved = await savedQueue(`${P}user`);
            expect(saved.ids).toBeNull();
            expect(saved.index).toBe(0);
            expect(saved.row.queueSource).toBeNull();
            expect(saved.row.position).toBe(0);
            // Nothing is current any more.
            expect(saved.row.trackId).toBeNull();
        });

        it("keeps the track the state names when the current song was not the one dropped", async () => {
            await seedQueue(`${P}user`, q("a", "b", "c"), 2);
            await sweep();
            const saved = await savedQueue(`${P}user`);
            expect(saved.row.trackId).toBe(`${P}qc`);
            expect(saved.ids![saved.index]).toBe(`${P}qc`);
        });

        it("a change the server makes carries no client's name, so another device sees it as somebody else's", async () => {
            await seedQueue(`${P}user`, q("a", "b", "c"), 0, { changedBy: "Symfonium" });
            await sweep();
            expect((await savedQueue(`${P}user`)).row.changedBy).toBeNull();
        });

        it("leaves a queue it did not touch with the client that saved it", async () => {
            await seedQueue(`${P}user`, q("a", "c", "e"), 0, { changedBy: "Symfonium" });
            await sweep();
            expect((await savedQueue(`${P}user`)).row.changedBy).toBe("Symfonium");
        });

        describe("a song replaced by another copy", () => {
            // qb is gone and qbcopy is the same song on the same album: the queue keeps its place on the copy.
            beforeEach(async () => {
                await prisma.track.create({
                    data: { id: `${P}qbcopy`, albumId: `${P}alb`, title: `${P}qb title`.toUpperCase(), displayTitle: "edited b", trackNo: 1, duration: 201,
                        filePath: `/tmp/${P}qbcopy.flac`, fileModified: new Date(), fileSize: 1 },
                });
            });

            it("points the queue's entry at the copy, described as the copy, and keeps every other entry", async () => {
                await seedQueue(`${P}user`, q("a", "b", "c", "d", "e"), 4, { queueSource: "album:x" });
                await sweep();
                const saved = await savedQueue(`${P}user`);
                // d has no copy and goes; b stays in its place as the copy.
                expect(saved.ids).toEqual([`${P}qa`, `${P}qbcopy`, `${P}qc`, `${P}qe`]);
                expect(saved.index).toBe(3);
                const copy = (saved.row.queue as Array<Record<string, any>>)[1];
                expect(copy).toMatchObject({
                    id: `${P}qbcopy`, title: `${P}qb title`.toUpperCase(), displayTitle: "edited b", duration: 201,
                    artist: { id: `${P}art`, name: "Recon Artist" },
                    album: { id: `${P}alb`, title: "Recon Album" },
                });
                expect(saved.row.queueSource).toBe("album:x");
            });

            it("when the current song was replaced, the copy is current, from the same offset", async () => {
                await seedQueue(`${P}user`, q("a", "b", "c"), 1, { position: 4000 });
                await sweep();
                const saved = await savedQueue(`${P}user`);
                expect(saved.ids).toEqual([`${P}qa`, `${P}qbcopy`, `${P}qc`]);
                expect(saved.index).toBe(1);
                expect(saved.row.trackId).toBe(`${P}qbcopy`);
                // The same song, so the listener's place in it is kept.
                expect(saved.row.position).toBe(4000);
            });

            it("a queue holding a song and its copy keeps both", async () => {
                await seedQueue(`${P}user`, q("b"), 0);
                await prisma.playbackState.update({
                    where: { userId: `${P}user` },
                    data: { queue: [entry(`${P}qb`), entry(`${P}qbcopy`)] },
                });
                await sweep();
                expect((await savedQueue(`${P}user`)).ids).toEqual([`${P}qbcopy`, `${P}qbcopy`]);
            });

            it("a state naming the replaced song as its track and holding no queue names the copy", async () => {
                await prisma.playbackState.create({ data: { userId: `${P}user`, playbackType: "track", trackId: `${P}qb` } });
                await sweep();
                expect((await prisma.playbackState.findUnique({ where: { userId: `${P}user` } }))!.trackId).toBe(`${P}qbcopy`);
            });

            it("a copy that is corrupt is no copy for a queue (it takes the history, below): the entry goes, and the track the state names follows the queue", async () => {
                await prisma.track.update({ where: { id: `${P}qbcopy` }, data: { corrupt: true } });
                await seedQueue(`${P}user`, q("a", "b", "c"), 1);
                await sweep();
                const saved = await savedQueue(`${P}user`);
                expect(saved.ids).toEqual([`${P}qa`, `${P}qc`]);
                expect(saved.row.trackId).toBe(`${P}qc`);
            });

            it("a corrupt copy beside a playable one: the playable one is the copy", async () => {
                await prisma.track.update({ where: { id: `${P}qbcopy` }, data: { corrupt: true } });
                await prisma.track.create({
                    data: { id: `${P}qbcopy2`, albumId: `${P}alb`, title: `${P}qb title`, trackNo: 1, duration: 200,
                        filePath: `/tmp/${P}qbcopy2.flac`, fileModified: new Date(), fileSize: 1 },
                });
                await seedQueue(`${P}user`, q("a", "b"), 1);
                await sweep();
                expect((await savedQueue(`${P}user`)).ids).toEqual([`${P}qa`, `${P}qbcopy2`]);
            });

            it("a copy on a Discover album is no copy: Discover songs reach no library queue", async () => {
                await prisma.album.create({
                    data: { id: `${P}qdisc`, artistId: `${P}art`, rgMbid: `${P}-qdrg`, identityKey: `${P}-qdak`, title: "Recon Discover", primaryType: "Album", location: "DISCOVER" },
                });
                for (const [id, gone] of [["qdgone", true], ["qdcopy", false]] as const) {
                    await prisma.track.create({
                        data: { id: `${P}${id}`, albumId: `${P}qdisc`, title: "disc song", trackNo: 1, duration: 200, filePath: `/tmp/${P}${id}.flac`,
                            fileModified: new Date(), fileSize: 1, ...(gone ? { missingSince: new Date(Date.now() - 5 * MIN) } : {}) },
                    });
                }
                await seedQueue(`${P}user`, [`${P}qa`, `${P}qdgone`], 0);
                await sweep();
                expect((await savedQueue(`${P}user`)).ids).toEqual([`${P}qa`]);
            });

            it("a state naming a song with no copy and holding no queue names nothing", async () => {
                await prisma.playbackState.create({ data: { userId: `${P}user`, playbackType: "track", trackId: `${P}qd` } });
                await sweep();
                expect((await prisma.playbackState.findUnique({ where: { userId: `${P}user` } }))!.trackId).toBeNull();
            });
        });

        it("fixes every user's queue and leaves one with no retired song exactly as it was", async () => {
            await prisma.user.create({ data: { id: OTHER_Q, username: OTHER_Q, passwordHash: "x", role: "user", tokenVersion: 0 } });
            await seedQueue(`${P}user`, q("d", "a", "c"), 1);
            await seedQueue(OTHER_Q, q("a", "c", "e"), 2, { queueSource: "playlist:y", position: 900 });
            const before = await savedQueue(OTHER_Q);
            await sweep();
            expect((await savedQueue(`${P}user`)).ids).toEqual(q("a", "c"));
            expect((await savedQueue(`${P}user`)).index).toBe(0);
            const after = await savedQueue(OTHER_Q);
            expect(after.ids).toEqual(before.ids);
            expect(after.index).toBe(2);
            expect(after.row.queueSource).toBe("playlist:y");
            expect(after.row.position).toBe(900);
            expect(after.row.updatedAt).toEqual(before.row.updatedAt);
        });

        it("leaves a queue that is not a list alone", async () => {
            await prisma.playbackState.create({ data: { userId: `${P}user`, playbackType: "track", queue: { odd: true } } });
            await expect(sweep()).resolves.toMatchObject({ removed: 2 });
            expect((await prisma.playbackState.findUnique({ where: { userId: `${P}user` } }))!.queue).toEqual({ odd: true });
        });
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

/**
 * A retiring song's history goes to a copy of the same song on a LIBRARY album, whether or not that copy can be played
 * (a corrupt file is repaired, or replaced, and the history is there when it is); its saved queues are pointed only at a
 * copy a person can play. Among copies the better file is chosen: the playable one, then lossless, then the higher
 * bitrate, then the lower id. A Discover copy gets nothing.
 */
describe("which copy takes over", () => {
    interface CopyOpts { corrupt?: boolean; missing?: boolean; album?: string; mime?: string; fileSize?: number; duration?: number; bitrate?: number }
    const SLOT = { trackNo: 1, title: "Schema" };

    async function seedGone(id = "g") {
        await prisma.track.create({
            data: { id: `${P}${id}`, albumId: `${P}alb`, ...SLOT, duration: 200, filePath: `/tmp/${P}${id}.mp3`, fileModified: new Date(), fileSize: 1,
                missingSince: new Date(Date.now() - 5 * MIN) },
        });
    }
    async function seedCopy(id: string, opts: CopyOpts = {}) {
        await prisma.track.create({
            data: { id: `${P}${id}`, albumId: opts.album ?? `${P}alb`, ...SLOT, title: "SCHEMA", duration: opts.duration ?? 200,
                filePath: `/tmp/${P}${id}.bin`, fileModified: new Date(), fileSize: opts.fileSize ?? 1, mime: opts.mime ?? "MPEG 1 Layer 3",
                corrupt: opts.corrupt ?? false, bitrate: opts.bitrate ?? null, ...(opts.missing ? { missingSince: new Date(Date.now() - 5 * MIN) } : {}) },
        });
    }
    async function seedHistoryAndQueue(goneId = "g") {
        await prisma.play.create({ data: { userId: `${P}user`, trackId: `${P}${goneId}`, playedAt: new Date(Date.now() - 3 * MIN) } });
        await prisma.likedTrack.create({ data: { userId: `${P}user`, trackId: `${P}${goneId}` } });
        await prisma.playlist.create({
            data: { id: `${P}pl`, userId: `${P}user`, name: "Recon", items: { create: [{ trackId: `${P}${goneId}`, rank: "a", sort: 0 }] } },
        });
        const entry = { id: `${P}${goneId}`, title: "Schema", displayTitle: null, duration: 200, artist: null, album: null };
        await prisma.playbackState.create({ data: { userId: `${P}user`, playbackType: "track", trackId: `${P}${goneId}`, queue: [entry], currentIndex: 0 } });
    }
    const sweep = () => prisma.$transaction((tx) => reconcileDeletedTracks(tx, scanStartedAt()));
    async function where() {
        const [play] = await prisma.play.findMany({ where: { userId: `${P}user` } });
        const like = await prisma.likedTrack.findFirst({ where: { userId: `${P}user` } });
        const item = await prisma.playlistItem.findFirst({ where: { playlistId: `${P}pl` } });
        const state = await prisma.playbackState.findUnique({ where: { userId: `${P}user` } });
        return {
            play: play?.trackId ?? null,
            like: like?.trackId ?? null,
            item: item?.trackId ?? null,
            queue: (state?.queue as Array<{ id: string }> | null)?.map((e) => e.id) ?? null,
            stateTrack: state?.trackId ?? null,
        };
    }

    it("a corrupt library copy takes the history, and the queue drops the song: nobody is pointed at a file that cannot play", async () => {
        await seedGone();
        await seedCopy("bad", { corrupt: true });
        await seedHistoryAndQueue();

        expect((await sweep()).removed).toBe(1);

        expect(await where()).toEqual({ play: `${P}bad`, like: `${P}bad`, item: `${P}bad`, queue: null, stateTrack: null });
        const log = await prisma.removalLog.findFirstOrThrow({ where: { filePath: `/tmp/${P}g.mp3` } });
        expect(log.reason).toBe("replaced-by-another-file");
        // The corrupt song is still there: a fixed file comes back with its history.
        expect(await prisma.track.findUnique({ where: { id: `${P}bad` } })).not.toBeNull();
    });

    it("a copy on a Discover album gets nothing: no history, no queue place", async () => {
        await prisma.album.create({
            data: { id: `${P}disc`, artistId: `${P}art`, rgMbid: `${P}-drg2`, identityKey: `${P}-dak2`, title: "Recon Discover", primaryType: "Album", location: "DISCOVER" },
        });
        // The retiring song is on the library album; its only look-alike is on a Discover album.
        await seedGone();
        await seedCopy("disc", { album: `${P}disc` });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toEqual({ play: null, like: null, item: null, queue: null, stateTrack: null });
        expect((await prisma.removalLog.findFirstOrThrow({ where: { filePath: `/tmp/${P}g.mp3` } })).reason).toBe("file-missing-confirmed");
    });

    it("a copy whose own file is missing is no copy", async () => {
        await seedGone();
        await seedCopy("lost", { missing: true });
        await seedHistoryAndQueue();

        await sweep();

        // Both flagged songs retire in the one sweep; the history of neither lands on the other.
        expect(await where()).toEqual({ play: null, like: null, item: null, queue: null, stateTrack: null });
    });

    it("a playable copy takes both the history and the queue place, whatever a corrupt lossless copy offers", async () => {
        await seedGone();
        await seedCopy("a-flac-bad", { corrupt: true, mime: "FLAC", fileSize: 30_000_000 });
        await seedCopy("z-mp3", { mime: "MPEG 1 Layer 3", fileSize: 4_000_000 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toEqual({ play: `${P}z-mp3`, like: `${P}z-mp3`, item: `${P}z-mp3`, queue: [`${P}z-mp3`], stateTrack: `${P}z-mp3` });
    });

    it("of two playable copies, the lossless one wins even when its id sorts later", async () => {
        await seedGone();
        await seedCopy("a-mp3", { mime: "MPEG 1 Layer 3", fileSize: 8_000_000 });
        await seedCopy("z-flac", { mime: "FLAC", fileSize: 1_000_000 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toMatchObject({ play: `${P}z-flac`, queue: [`${P}z-flac`] });
    });

    it("of two lossy copies the higher bitrate wins, and equal quality goes to the lower id", async () => {
        await seedGone();
        await seedCopy("a-low", { fileSize: 2_000_000 });
        await seedCopy("m-high", { fileSize: 6_000_000 });
        await seedCopy("z-high", { fileSize: 6_000_000 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toMatchObject({ play: `${P}m-high`, queue: [`${P}m-high`] });
    });

    // The file's own bitrate, once the scan has read it, is the better measure: the size over the duration also counts
    // tags, art and padding. A copy with none stored is ranked by size over duration, in the same kbps.
    it("ranks by the stored bitrate when the copies have one, whatever their sizes", async () => {
        await seedGone();
        await seedCopy("a-big", { fileSize: 9_000_000, bitrate: 128 });
        await seedCopy("b-small", { fileSize: 1_000_000, bitrate: 320 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toMatchObject({ play: `${P}b-small`, queue: [`${P}b-small`] });
    });

    it("ranks a copy with no stored bitrate by its size over its duration, against one with a stored bitrate, in kbps", async () => {
        // 200 s: 9 MB is 360 kbps, 2 MB is 80 kbps.
        await seedGone();
        await seedCopy("a-stored", { fileSize: 1, bitrate: 320 });
        await seedCopy("b-unread", { fileSize: 9_000_000 });
        await seedCopy("c-unread-low", { fileSize: 2_000_000 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toMatchObject({ play: `${P}b-unread` });
    });

    it("a copy with no stored bitrate and a small size does not outrank a stored 128 kbps one", async () => {
        await seedGone();
        await seedCopy("a-unread", { fileSize: 2_000_000 });
        await seedCopy("b-stored", { fileSize: 1, bitrate: 128 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toMatchObject({ play: `${P}b-stored` });
    });

    it("a copy of unknown duration and no stored bitrate ranks last", async () => {
        await seedGone();
        await seedCopy("a-nodur", { duration: 0, fileSize: 9_000_000 });
        await seedCopy("b-stored", { fileSize: 1, bitrate: 128 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toMatchObject({ play: `${P}b-stored` });
    });

    it("a copy of unknown duration ranks last by bitrate", async () => {
        await seedGone();
        await seedCopy("a-nodur", { duration: 0, fileSize: 9_000_000 });
        await seedCopy("b-known", { fileSize: 1_000_000 });
        await seedHistoryAndQueue();

        await sweep();

        expect(await where()).toMatchObject({ play: `${P}b-known` });
    });

    it("holds the copy it chose against a delete or a key change until the sweep commits, but not against ordinary writes, and holds no other candidate", async () => {
        await seedGone();
        await seedCopy("chosen", { mime: "FLAC" });
        await seedCopy("other", { mime: "MPEG 1 Layer 3" });
        await seedHistoryAndQueue();

        await prisma.$transaction(async (tx) => {
            await reconcileDeletedTracks(tx, scanStartedAt());
            const probe = (lock: string, id: string) =>
                prisma.$transaction(async (other) => {
                    await other.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
                    await other.$queryRawUnsafe(`SELECT id FROM "Track" WHERE id = $1 ${lock}`, id);
                });
            await expect(probe("FOR UPDATE", `${P}chosen`)).rejects.toThrow();
            await expect(probe("FOR NO KEY UPDATE", `${P}chosen`)).resolves.toBeUndefined();
            await expect(probe("FOR UPDATE", `${P}other`)).resolves.toBeUndefined();
        }, { timeout: 30_000 });
    });

    describe("a saved mood mix", () => {
        const mix = (trackIds: string[], servedTrackIds: string[]) =>
            prisma.userMoodMix.create({
                data: { userId: `${P}user`, mood: "happy", trackIds: trackIds.map((i) => `${P}${i}`), servedTrackIds: servedTrackIds.map((i) => `${P}${i}`), coverUrls: [], generatedAt: new Date() },
            });
        const saved = async () => {
            const row = await prisma.userMoodMix.findUniqueOrThrow({ where: { userId: `${P}user` } });
            const bare = (ids: string[]) => ids.map((i) => i.slice(P.length));
            return { trackIds: bare(row.trackIds), servedTrackIds: bare(row.servedTrackIds), updatedAt: row.updatedAt };
        };

        it("follows a retired song to the copy that took its history, in the same place, in the mix and in the songs it was served", async () => {
            await seedGone();
            await seedCopy("copy");
            await seedCopy("other");
            await mix(["x", "g", "y"], ["g", "x"]);

            await sweep();

            const { trackIds, servedTrackIds } = await saved();
            expect(trackIds).toEqual(["x", "copy", "y"]);
            expect(servedTrackIds).toEqual(["copy", "x"]);
        });

        it("follows a retired song to a corrupt copy too, as its plays do: the mix reads its songs again, so the file is skipped until it is fixed", async () => {
            await seedGone();
            await seedCopy("bad", { corrupt: true });
            await mix(["g"], ["g"]);

            await sweep();

            expect(await saved()).toMatchObject({ trackIds: ["bad"], servedTrackIds: ["bad"] });
        });

        it("holds a copy once when the mix already held it", async () => {
            await seedGone();
            await seedCopy("copy");
            await mix(["copy", "x", "g"], ["g", "copy"]);

            await sweep();

            const { trackIds, servedTrackIds } = await saved();
            expect(trackIds).toEqual(["copy", "x"]);
            expect(servedTrackIds).toEqual(["copy"]);
        });

        it("drops a retired song that has no copy, and keeps the rest in order", async () => {
            await seedGone();
            await mix(["x", "g", "y"], ["y", "g"]);

            await sweep();

            const { trackIds, servedTrackIds } = await saved();
            expect(trackIds).toEqual(["x", "y"]);
            expect(servedTrackIds).toEqual(["y"]);
        });

        it("leaves a mix that held no retired song as it was, untouched", async () => {
            await seedGone();
            await mix(["x", "y"], ["y"]);
            const before = await saved();

            await sweep();

            expect(await saved()).toEqual(before);
        });
    });
});
