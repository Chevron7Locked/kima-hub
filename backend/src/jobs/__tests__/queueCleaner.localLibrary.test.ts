/**
 * A download whose album reached the library without any Lidarr event is
 * completed by the library sweep, and its user is told. Only the same artist's
 * album counts, in any edition.
 */

import { prisma } from "../../utils/db";
import { queueCleaner } from "../queueCleaner";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { artistIdentityKey } from "../../services/artistIdentity";

const USER = "qc_local_user";
const ARTIST = "qc_local_interpol";

const job = (id: string, artistName: string, albumTitle: string) =>
    prisma.downloadJob.create({
        data: {
            id, userId: USER, subject: `${artistName} - ${albumTitle}`, type: "album", status: "processing",
            targetMbid: `rg-${id}`, metadata: { artistName, albumTitle },
        },
    });

const status = async (id: string) => (await prisma.downloadJob.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.artist.create({
        data: { id: ARTIST, name: "Interpol", identityKey: artistIdentityKey("Interpol"), sortName: "interpol", normalizedName: ARTIST },
    });
    await prisma.album.create({
        data: {
            id: "qc_local_alive", rgMbid: "rg-qc-alive", artistId: ARTIST, title: "Antics (Deluxe Edition)",
            identityKey: "qc_local_alive", sortName: "antics", primaryType: "Album", location: "LIBRARY",
            tracks: {
                create: {
                    id: "qc_local_t1", title: "Next Exit", trackNo: 1, duration: 200,
                    filePath: "qc/next-exit.flac", fileModified: new Date(), fileSize: 1,
                },
            },
        },
    });
});

afterEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { albumId: "qc_local_alive" } });
    await prisma.album.deleteMany({ where: { artistId: ARTIST } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("completes a download found in the library as another edition and tells the user", async () => {
    await job("qc_a", "Interpol", "Antics");

    expect(await queueCleaner.reconcileWithLocalLibrary()).toEqual({ reconciled: 1 });

    expect(await status("qc_a")).toBe("completed");
    expect(await prisma.notification.count({ where: { userId: USER, type: "download_complete" } })).toBe(1);
});

it("does not take a title inside another title, or another artist's album, as the download", async () => {
    await job("qc_b", "Interpol", "Antic");
    await job("qc_c", "Muse", "Antics");

    expect(await queueCleaner.reconcileWithLocalLibrary()).toEqual({ reconciled: 0 });

    expect(await status("qc_b")).toBe("processing");
    expect(await status("qc_c")).toBe("processing");
});

it("leaves a job Lidarr is fetching to Lidarr, even when a same-titled album is in the library", async () => {
    await prisma.downloadJob.create({
        data: {
            id: "qc_d", userId: USER, subject: "Interpol - Antics", type: "album", status: "processing",
            targetMbid: "rg-qc_d", lidarrAlbumId: 7, metadata: { artistName: "Interpol", albumTitle: "Antics" },
        },
    });

    expect(await queueCleaner.reconcileWithLocalLibrary()).toEqual({ reconciled: 0 });
    expect(await status("qc_d")).toBe("processing");
});

it("does not count a live recording as another edition of the album", async () => {
    await job("qc_e", "Interpol", "Antics (Live)");
    expect(await queueCleaner.reconcileWithLocalLibrary()).toEqual({ reconciled: 0 });
});

it("matches a download by an artist named only in punctuation by that exact name, never by an empty key", async () => {
    // "!!!" and "-" have no letters or digits, so no identity key ("-" is stored with an empty one, as an older
    // resolve could leave it); "-"'s same-titled album is not "!!!"'s.
    await prisma.artist.create({ data: { id: "qc_local_dash", name: "-", identityKey: "", sortName: "-", normalizedName: "-" } });
    await prisma.album.create({
        data: {
            id: "qc_local_dash_alb", rgMbid: "rg-qc-dash", artistId: "qc_local_dash", title: "Myth Takes",
            identityKey: "qc_local_dash_alb", sortName: "myth takes", primaryType: "Album", location: "LIBRARY",
            tracks: { create: { id: "qc_local_dash_t1", title: "Heart Of Hearts", trackNo: 1, duration: 200, filePath: "qc/dash.flac", fileModified: new Date(), fileSize: 1 } },
        },
    });
    await job("qc-chk", "!!!", "Myth Takes");
    try {
        await queueCleaner.reconcileWithLocalLibrary();
        expect(await status("qc-chk")).toBe("processing");

        await prisma.artist.create({ data: { id: "qc_local_chk", name: "!!!", identityKey: "qc_local_chk_key", sortName: "!!!", normalizedName: "!!!" } });
        await prisma.album.create({
            data: {
                id: "qc_local_chk_alb", rgMbid: "rg-qc-chk", artistId: "qc_local_chk", title: "Myth Takes (Deluxe)",
                identityKey: "qc_local_chk_alb", sortName: "myth takes", primaryType: "Album", location: "LIBRARY",
                tracks: { create: { id: "qc_local_chk_t1", title: "All My Heroes", trackNo: 1, duration: 200, filePath: "qc/chk.flac", fileModified: new Date(), fileSize: 1 } },
            },
        });
        await queueCleaner.reconcileWithLocalLibrary();
        expect(await status("qc-chk")).toBe("completed");
    } finally {
        await prisma.track.deleteMany({ where: { id: { in: ["qc_local_dash_t1", "qc_local_chk_t1"] } } });
        await prisma.album.deleteMany({ where: { id: { in: ["qc_local_dash_alb", "qc_local_chk_alb"] } } });
        await prisma.artist.deleteMany({ where: { id: { in: ["qc_local_dash", "qc_local_chk"] } } });
    }
});

it("matches an accented artist whatever case the download names it in", async () => {
    const name = "Björk";
    await prisma.artist.create({
        data: { id: "qc_local_bjork", name, identityKey: artistIdentityKey(name), sortName: "bjork", normalizedName: "bjork" },
    });
    await prisma.album.create({
        data: {
            id: "qc_local_bjork_alb", rgMbid: "rg-qc-bjork", artistId: "qc_local_bjork", title: "Homogenic",
            identityKey: "qc_local_bjork_alb", sortName: "homogenic", primaryType: "Album", location: "LIBRARY",
            tracks: {
                create: {
                    id: "qc_local_bjork_t1", title: "Hunter", trackNo: 1, duration: 200,
                    filePath: "qc/hunter.flac", fileModified: new Date(), fileSize: 1,
                },
            },
        },
    });
    try {
        await prisma.downloadJob.create({
            data: {
                id: "qc_bjork", userId: USER, subject: "BJÖRK - Homogenic", type: "album", status: "processing",
                metadata: { artistName: "BJÖRK", albumTitle: "Homogenic" },
            },
        });
        expect(await queueCleaner.reconcileWithLocalLibrary()).toEqual({ reconciled: 1 });
        expect(await status("qc_bjork")).toBe("completed");
    } finally {
        await prisma.track.deleteMany({ where: { albumId: "qc_local_bjork_alb" } });
        await prisma.album.deleteMany({ where: { artistId: "qc_local_bjork" } });
        await prisma.artist.deleteMany({ where: { id: "qc_local_bjork" } });
    }
});
