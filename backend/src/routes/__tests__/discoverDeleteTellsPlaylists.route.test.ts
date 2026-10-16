/**
 * Discover deleting its albums takes their songs out of every playlist that held them (the database removes the
 * entries), so each such playlist's owner is told, whoever triggered the delete: clearing Discover (its active albums,
 * and Discover albums no record points at any more) and the rejected-album cleanup. Real database, real router,
 * service and event bus; Lidarr is not configured and its removal call is a stand-in; auth is passed through.
 */

jest.mock("../../middleware/auth", () => ({
    ...jest.requireActual("../../middleware/auth"),
    requireAuthOrToken: (_req: any, _res: any, next: any) => next(),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    requireAcquirePermission: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../services/discovery/lidarrRemoval", () => ({ removeDiscoveryAlbum: jest.fn() }));

import express from "express";
import request from "supertest";
import discoverRoutes from "../discover";
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { eventBus, type SSEEvent } from "../../services/eventBus";
import { discoveryAlbumLifecycle } from "../../services/discovery/discoveryAlbumLifecycle";

const MARK = "zz-discover-delete";
let listener: string;
let other: string;
const heard: Record<string, SSEEvent[]> = {};
const stops: Array<() => void> = [];

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
    req.user = { id: listener, username: `${MARK}-listener`, role: "admin" };
    next();
});
app.use("/discover", discoverRoutes);

async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

/** A Discover album with one song, and (unless orphaned) the Discover record pointing at it. */
async function discoverAlbum(tag: string, opts: { orphan?: boolean } = {}) {
    const artist = await prisma.artist.create({ data: { name: `${MARK} ${tag}`, identityKey: `${MARK}-${tag}` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-${tag}-rg`, identityKey: `${MARK}-${tag}-album`, primaryType: "Album", title: `${MARK} ${tag} Album`, artistId: artist.id, location: "DISCOVER" },
    });
    const track = await prisma.track.create({
        data: { title: `${MARK} ${tag} song`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${MARK}-outside/${tag}.flac`, fileModified: new Date(), fileSize: 1000 },
    });
    const record = opts.orphan
        ? null
        : await prisma.discoveryAlbum.create({
              data: { userId: listener, rgMbid: album.rgMbid, artistName: artist.name, albumTitle: album.title, weekStartDate: new Date(), status: "ACTIVE" },
          });
    return { track: track.id, record };
}

const playlistOf = async (userId: string, trackId: string) =>
    (await prisma.playlist.create({ data: { userId, name: `${MARK} list`, items: { create: [{ trackId, sort: 0, rank: "a" }] } } })).id;

const announced = (userId: string) => heard[userId].filter((e) => e.type === "playlist:updated").map((e) => e.payload.playlistId);

beforeAll(async () => {
    await cleanup();
    listener = (await prisma.user.create({ data: { username: `${MARK}-listener`, passwordHash: "x" } })).id;
    other = (await prisma.user.create({ data: { username: `${MARK}-other`, passwordHash: "x" } })).id;
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", lidarrEnabled: false }, update: { lidarrEnabled: false } });
    invalidateSystemSettingsCache();
    for (const user of [listener, other]) {
        heard[user] = [];
        stops.push(eventBus.subscribe(user, { send: (event) => (heard[user].push(event), true) }));
    }
});

afterAll(async () => {
    stops.forEach((stop) => stop());
    await cleanup();
});

beforeEach(() => {
    heard[listener].length = 0;
    heard[other].length = 0;
});

describe("Discover deleting albums tells the playlists that held their songs", () => {
    it("clearing Discover: an active album, and an album no Discover record points at", async () => {
        const active = await discoverAlbum("active");
        const orphan = await discoverAlbum("orphan", { orphan: true });
        const mine = await playlistOf(listener, active.track);
        const theirs = await playlistOf(other, orphan.track);

        const res = await request(app).delete("/discover/clear");

        expect(res.status).toBe(200);
        expect(await prisma.track.count({ where: { id: { in: [active.track, orphan.track] } } })).toBe(0);
        expect(announced(listener)).toEqual([mine]);
        expect(announced(other)).toEqual([theirs]);
    });

    it("the rejected-album cleanup", async () => {
        const rejected = await discoverAlbum("rejected");
        const theirs = await playlistOf(other, rejected.track);

        await discoveryAlbumLifecycle.deleteRejectedAlbum({
            id: rejected.record!.id,
            rgMbid: rejected.record!.rgMbid,
            artistName: rejected.record!.artistName,
            albumTitle: rejected.record!.albumTitle,
            lidarrAlbumId: null,
        });

        expect(await prisma.track.count({ where: { id: rejected.track } })).toBe(0);
        expect(announced(other)).toEqual([theirs]);
    });
});
