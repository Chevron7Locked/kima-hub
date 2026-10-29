/**
 * An imported playlist keeps the source's order, whichever way each song was found in the library: a song found only
 * by its title (credited to another artist in the source) sits where the source has it, not after the others. Real
 * database and Redis.
 */
jest.mock("../deezer", () => ({
    deezerService: { getTrackPreview: jest.fn().mockResolvedValue(null) },
}));

import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { spotifyImportService } from "../spotifyImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-import-order";
const USER = `${P}-user`;
const JOB = `${P}-job`;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.spotifyImportJob.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artist = await prisma.artist.create({ data: { name: `${P} Band`, normalizedName: `${P} band`, identityKey: `${P}-band` } });
    const album = await prisma.album.create({ data: { rgMbid: `${P}-rg`, identityKey: `${P}-album`, primaryType: "Album", title: `${P} Album`, artistId: artist.id, location: "LIBRARY" } });
    for (const [n, title] of [[1, `${P} a much longer opening title`], [2, `${P} second song`], [3, `${P} third song`], [4, `${P} fourth song`]] as const) {
        await prisma.track.create({ data: { title, albumId: album.id, trackNo: n, duration: 100, filePath: `/${P}/${n}.flac`, fileModified: new Date(), fileSize: 1 } });
    }
});

afterEach(async () => {
    await redisClient.del(`import:job:${JOB}`);
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const pending = (title: string, artist: string) => ({ artist, title, album: "x", albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null });

it("keeps the source order for a song found only by its title", async () => {
    const job = {
        id: JOB, userId: USER, spotifyPlaylistId: "pl", playlistName: `${P} list`, status: "scanning", progress: 80,
        albumsTotal: 0, albumsCompleted: 0, tracksMatched: 0, tracksTotal: 4, tracksDownloadable: 0, createdPlaylistId: null,
        error: null, sourceUrl: null, createdAt: new Date(), updatedAt: new Date(),
        pendingTracks: [
            pending(`${P} a much longer opening title`, "Someone Else Entirely"),
            pending(`${P} second song`, `${P} Band`),
            pending(`${P} third song`, `${P} Band`),
            pending(`${P} fourth song`, `${P} Band`),
        ],
    };

    await (spotifyImportService as any).buildPlaylist(job);

    const playlist = await prisma.playlist.findFirstOrThrow({
        where: { userId: USER },
        include: { items: { orderBy: { rank: "asc" }, include: { track: { select: { title: true } } } } },
    });
    expect(playlist.items.map((i) => i.track.title)).toEqual([
        `${P} a much longer opening title`,
        `${P} second song`,
        `${P} third song`,
        `${P} fourth song`,
    ]);
});
