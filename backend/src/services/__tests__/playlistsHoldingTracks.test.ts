/**
 * Songs leaving the library take their playlist entries with them (the database removes those), so the owners of the
 * playlists that held them are told, once each, after the delete. A playlist that held none of them hears nothing.
 * Real database and event bus; listeners subscribe the way connected devices do.
 */
import { prisma } from "../../utils/db";
import { eventBus, type SSEEvent } from "../eventBus";
import { announcePlaylistsChanged, playlistsHoldingTracks } from "../playlistEvents";

const MARK = "zz-playlists-holding";
const heard: Record<string, SSEEvent[]> = {};
const stops: Array<() => void> = [];
let alice: string;
let bob: string;
let songs: string[];

async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    alice = (await prisma.user.create({ data: { username: `${MARK}-alice`, passwordHash: "x" } })).id;
    bob = (await prisma.user.create({ data: { username: `${MARK}-bob`, passwordHash: "x" } })).id;
    for (const user of [alice, bob]) {
        heard[user] = [];
        stops.push(eventBus.subscribe(user, { send: (event) => (heard[user].push(event), true) }));
    }
});

afterAll(async () => {
    stops.forEach((stop) => stop());
    await cleanup();
});

beforeEach(async () => {
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    songs = [];
    for (let i = 0; i < 3; i += 1) {
        const track = await prisma.track.create({
            data: { title: `${MARK} Song ${i}`, albumId: album.id, trackNo: i + 1, duration: 100, filePath: `/${MARK}/${i}.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        songs.push(track.id);
    }
    heard[alice].length = 0;
    heard[bob].length = 0;
});

const playlist = (userId: string, held: string[]) =>
    prisma.playlist.create({
        data: { userId, name: `${MARK} list`, items: { create: held.map((trackId, i) => ({ trackId, sort: i, rank: "abc"[i] })) } },
    });

const announced = (userId: string) => heard[userId].filter((e) => e.type === "playlist:updated").map((e) => e.payload);

describe("songs deleted from the library", () => {
    it("tell each owner of a playlist that held them, once per playlist, after the delete", async () => {
        const both = await playlist(alice, [songs[0], songs[1]]);
        const bobs = await playlist(bob, [songs[1]]);
        const untouched = await playlist(alice, [songs[2]]);

        const held = await playlistsHoldingTracks(prisma, { id: { in: [songs[0], songs[1]] } });
        expect(announced(alice)).toEqual([]);
        await prisma.track.deleteMany({ where: { id: { in: [songs[0], songs[1]] } } });
        announcePlaylistsChanged(held);

        expect(announced(alice)).toEqual([{ playlistId: both.id, deleted: false }]);
        expect(announced(bob)).toEqual([{ playlistId: bobs.id, deleted: false }]);
        expect(await prisma.playlistItem.count({ where: { playlistId: untouched.id } })).toBe(1);
    });

    it("read inside a transaction, tell once it has committed", async () => {
        const list = await playlist(alice, [songs[0]]);

        const held = await prisma.$transaction(async (tx) => {
            const holding = await playlistsHoldingTracks(tx, { id: songs[0] });
            await tx.track.deleteMany({ where: { id: songs[0] } });
            return holding;
        });
        announcePlaylistsChanged(held);

        expect(announced(alice)).toEqual([{ playlistId: list.id, deleted: false }]);
    });

    it("tell nobody when no playlist held them", async () => {
        await playlist(alice, [songs[2]]);

        const held = await playlistsHoldingTracks(prisma, { id: songs[0] });
        await prisma.track.deleteMany({ where: { id: songs[0] } });
        announcePlaylistsChanged(held);

        expect(announced(alice)).toEqual([]);
        expect(announced(bob)).toEqual([]);
    });
});
