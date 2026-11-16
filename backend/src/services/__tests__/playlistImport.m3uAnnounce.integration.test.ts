/**
 * A playlist made from an M3U file reaches its owner's open devices as a live `playlist:updated` event. Real
 * database and event bus. A file in which nothing matches makes no playlist, so it announces none.
 */
import { prisma } from "../../utils/db";
import { eventBus, type SSEEvent } from "../eventBus";
import { artistIdentityKey } from "../artistIdentity";
import { playlistImportService } from "../playlistImport";
import { M3UNothingMatched } from "../playlistImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-m3u-announce";

async function cleanup() {
    await prisma.notification.deleteMany({ where: { userId: `${P}-usr` } });
    await prisma.user.deleteMany({ where: { id: `${P}-usr` } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: artistIdentityKey(P) } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: `${P}-usr`, username: `${P}-user`, passwordHash: "x" } });
    const name = `${P} band`;
    const artist = await prisma.artist.create({ data: { name, normalizedName: name, identityKey: artistIdentityKey(name) } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-rg`, identityKey: `${P}-album`, primaryType: "Album", title: `${P} album`, artistId: artist.id, location: "LIBRARY" },
    });
    await prisma.track.create({
        data: { id: `${P}-song`, title: `${P} song`, albumId: album.id, trackNo: 1, duration: 100, filePath: `${P}/album/${P}.flac`, fileModified: new Date(), fileSize: 1 },
    });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const heardDuring = async (filePath: string) => {
    const heard: SSEEvent[] = [];
    const stop = eventBus.subscribe(`${P}-usr`, { send: (event) => (heard.push(event), true) });
    const result = await playlistImportService
        .importFromM3U(`${P}-usr`, `${P} list`, [{ filePath, artist: null, title: null, durationSeconds: 100 }])
        .catch((error) => (error instanceof M3UNothingMatched ? null : Promise.reject(error)))
        .finally(stop);
    return { result, events: heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload) };
};

it("tells the owner's devices about the playlist an M3U file made", async () => {
    const { result, events } = await heardDuring(`${P}/album/${P}.flac`);
    expect(events).toEqual([{ playlistId: result!.playlistId, deleted: false }]);
});

it("announces nothing for a file in which nothing matched", async () => {
    const { result, events } = await heardDuring(`/nowhere/${P}-none.flac`);
    expect(result).toBeNull();
    expect(events).toEqual([]);
});
