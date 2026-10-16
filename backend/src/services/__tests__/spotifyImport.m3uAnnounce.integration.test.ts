/**
 * A playlist made from an M3U file reaches its owner's open devices as a live `playlist:updated` event. Real
 * database and event bus; nothing in the file matches the library, which still makes an (empty) playlist.
 */
import { prisma } from "../../utils/db";
import { eventBus, type SSEEvent } from "../eventBus";
import { spotifyImportService } from "../spotifyImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-m3u-announce";

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: `${P}-usr` } });
    await closeEngineConnections();
});

it("tells the owner's devices about the playlist an M3U file made", async () => {
    await prisma.user.deleteMany({ where: { id: `${P}-usr` } });
    await prisma.user.create({ data: { id: `${P}-usr`, username: `${P}-user`, passwordHash: "x" } });
    const heard: SSEEvent[] = [];
    const stop = eventBus.subscribe(`${P}-usr`, { send: (event) => (heard.push(event), true) });
    const result = await spotifyImportService
        .importFromM3U(`${P}-usr`, `${P} list`, [{ filePath: `/nowhere/${P}.flac`, artist: "Nobody", title: "Nothing", durationSeconds: 100 }])
        .finally(stop);

    expect(heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload)).toEqual([{ playlistId: result.playlistId, deleted: false }]);
});
