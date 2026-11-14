/**
 * Deleting a song, an album or an artist from the library takes those songs out of every playlist that held them
 * (the database removes the entries), so each such playlist's owner is told, once the delete is done; playlists that
 * held none of them hear nothing. Real database, real routers and event bus; the admin check is passed through.
 * Files sit outside the music folder, so the routes delete no file.
 */

jest.mock("../../../middleware/auth", () => ({
    ...jest.requireActual("../../../middleware/auth"),
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

import express from "express";
import request from "supertest";
import tracksRoutes from "../tracks";
import albumsRoutes from "../albums";
import artistsRoutes from "../artists";
import { prisma } from "../../../utils/db";
import { eventBus, type SSEEvent } from "../../../services/eventBus";
import { expectLog } from "../../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "../../__tests__/helpers/serverMount";
import { markerMoves } from "../../../__tests__/helpers/libraryMarker";

const MARK = "zz-library-delete";
const app = express();
app.use(express.json());
mountAsServer(app, "/", tracksRoutes, "/api/library", { standIn: true });
mountAsServer(app, "/", albumsRoutes, "/api/library", { standIn: true });
mountAsServer(app, "/", artistsRoutes, "/api/library", { standIn: true });

let owner: string;
const heard: SSEEvent[] = [];
let stop: () => void;

async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

/** An artist with one album of two songs. */
async function seedArtist(tag: string) {
    const artist = await prisma.artist.create({ data: { name: `${MARK} ${tag}`, identityKey: `${MARK}-${tag}` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-${tag}-rg`, identityKey: `${MARK}-${tag}-album`, primaryType: "Album", title: `${MARK} ${tag} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    const songs: string[] = [];
    for (let i = 0; i < 2; i += 1) {
        const track = await prisma.track.create({
            data: { title: `${MARK} ${tag} ${i}`, albumId: album.id, trackNo: i + 1, duration: 100, filePath: `/${MARK}-outside/${tag}/${i}.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        songs.push(track.id);
    }
    return { artist: artist.id, album: album.id, songs };
}

const playlistOf = async (songs: string[]) =>
    (await prisma.playlist.create({
        data: { userId: owner, name: `${MARK} list`, items: { create: songs.map((trackId, i) => ({ trackId, sort: i, rank: "abcd"[i] })) } },
    })).id;

const announced = () => heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload);

beforeAll(async () => {
    await cleanup();
    owner = (await prisma.user.create({ data: { username: `${MARK}-owner`, passwordHash: "x" } })).id;
    stop = eventBus.subscribe(owner, { send: (event) => (heard.push(event), true) });
});

afterAll(async () => {
    stop();
    await cleanup();
});

beforeEach(() => {
    heard.length = 0;
});

describe("deleting from the library tells the playlists that held the songs", () => {
    it("a song", async () => {
        expectLog("warn");
        const { songs } = await seedArtist("song");
        const holding = await playlistOf([songs[0]]);
        await playlistOf([songs[1]]);

        expect((await request(app).delete(`/tracks/${songs[0]}`)).status).toBe(200);

        expect(announced()).toEqual([{ playlistId: holding, deleted: false }]);
    });

    it("an album", async () => {
        expectLog("warn");
        const { album, songs } = await seedArtist("album");
        const holding = await playlistOf(songs);
        const other = await seedArtist("bystander");
        await playlistOf(other.songs);

        expect((await request(app).delete(`/albums/${album}`)).status).toBe(200);

        expect(announced()).toEqual([{ playlistId: holding, deleted: false }]);
        expect(await prisma.playlistItem.count({ where: { playlistId: holding } })).toBe(0);
    });

    it("an artist", async () => {
        expectLog("warn");
        const { artist, songs } = await seedArtist("artist");
        const first = await playlistOf([songs[0]]);
        const second = await playlistOf([songs[1]]);

        expect((await request(app).delete(`/artists/${artist}`)).status).toBe(200);

        expect(announced().map((p) => p.playlistId).sort()).toEqual([first, second].sort());
    });
});

describe("deleting from the library moves the library-changed marker", () => {
    it("for a song, an album and an artist on the library", async () => {
        expectLog("warn");
        const song = await seedArtist("mark-song");
        expect(await markerMoves(() => request(app).delete(`/tracks/${song.songs[0]}`))).toBe(true);

        const album = await seedArtist("mark-album");
        expect(await markerMoves(() => request(app).delete(`/albums/${album.album}`))).toBe(true);

        const artist = await seedArtist("mark-artist");
        expect(await markerMoves(() => request(app).delete(`/artists/${artist.artist}`))).toBe(true);
    });

    it("not for a Discover song, album or artist, which no client lists", async () => {
        expectLog("warn");
        const hide = async (tag: string) => {
            const seeded = await seedArtist(tag);
            await prisma.album.update({ where: { id: seeded.album }, data: { location: "DISCOVER" } });
            return seeded;
        };
        const song = await hide("hidden-song");
        expect(await markerMoves(() => request(app).delete(`/tracks/${song.songs[0]}`))).toBe(false);

        const album = await hide("hidden-album");
        expect(await markerMoves(() => request(app).delete(`/albums/${album.album}`))).toBe(false);

        const artist = await hide("hidden-artist");
        expect(await markerMoves(() => request(app).delete(`/artists/${artist.artist}`))).toBe(false);
    });

    it("not for songs a client does not list: a missing one or a corrupt one", async () => {
        expectLog("warn");
        const unlist = async (tag: string, data: { missingSince: Date } | { corrupt: true }) => {
            const seeded = await seedArtist(tag);
            await prisma.track.updateMany({ where: { id: { in: seeded.songs } }, data });
            return seeded;
        };
        const song = await unlist("unlisted-song", { missingSince: new Date() });
        expect(await markerMoves(() => request(app).delete(`/tracks/${song.songs[0]}`))).toBe(false);

        const album = await unlist("unlisted-album", { corrupt: true });
        expect(await markerMoves(() => request(app).delete(`/albums/${album.album}`))).toBe(false);

        const artist = await unlist("unlisted-artist", { missingSince: new Date() });
        expect(await markerMoves(() => request(app).delete(`/artists/${artist.artist}`))).toBe(false);
    });

    it("when an album or an artist is deleted with one playable song among unlisted ones", async () => {
        expectLog("warn");
        const mixed = async (tag: string) => {
            const seeded = await seedArtist(tag);
            await prisma.track.update({ where: { id: seeded.songs[0] }, data: { missingSince: new Date() } });
            return seeded;
        };
        const album = await mixed("mixed-album");
        expect(await markerMoves(() => request(app).delete(`/albums/${album.album}`))).toBe(true);

        const artist = await mixed("mixed-artist");
        expect(await markerMoves(() => request(app).delete(`/artists/${artist.artist}`))).toBe(true);
    });

    it("not when the delete finds nothing", async () => {
        expect(await markerMoves(() => request(app).delete(`/tracks/${MARK}-nothing`))).toBe(false);
    });
});
