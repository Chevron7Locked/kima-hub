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
                if (key !== "track") return typeof value === "function" ? value.bind(target) : value;
                return new Proxy(value, {
                    get(model, method) {
                        const fn = model[method];
                        if (method !== "deleteMany") return typeof fn === "function" ? fn.bind(model) : fn;
                        return async (...args: unknown[]) => {
                            report = recordPlay({ userId: LATE, trackId: `${P}mp3`, clientAttestedComplete: true });
                            await new Promise((resolve) => setTimeout(resolve, 500));
                            return fn.apply(model, args);
                        };
                    },
                });
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

        async function seedQueue(userId: string, ids: string[], currentIndex: number, extra: { queueSource?: string; position?: number } = {}) {
            await prisma.playbackState.upsert({
                where: { userId },
                create: { userId, playbackType: "track", trackId: ids[currentIndex] ?? null, queue: ids.map(entry), currentIndex, queueSource: extra.queueSource ?? null, position: extra.position ?? 0 },
                update: { trackId: ids[currentIndex] ?? null, queue: ids.map(entry), currentIndex, queueSource: extra.queueSource ?? null, position: extra.position ?? 0 },
            });
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
            expect(saved.row.trackId).toBeNull();
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
