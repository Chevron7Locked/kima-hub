/**
 * An import's title-only lookup reads at most 500 candidates, for a title with a non-ASCII letter too. Songs that cannot
 * play never use up those places: a song that plays still matches when more than 500 missing songs hold the same words
 * and sort ahead of it. Real database.
 */
import { prisma } from "../../utils/db";
import { playlistImportService } from "../playlistImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-import-limit";
const USER = `${P}-user`;
const PLAYLIST = `${P}-playlist`;
/** The words every title holds; the "ñ" sends the lookup down the non-ASCII path. */
const WORDS = `${P} ñandú song`;
const PLAYABLE_ID = `${P}-z-ok`;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    const artist = await prisma.artist.create({ data: { name: `${P} band`, normalizedName: `${P} band`, identityKey: `${P}-band` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-rg`, identityKey: `${P}-album`, primaryType: "Album", title: `${P} album`, artistId: artist.id, location: "LIBRARY" },
    });
    const song = (id: string, title: string, n: number, extra: object = {}) => ({
        id, title, albumId: album.id, trackNo: n, duration: 100, filePath: `/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1, ...extra,
    });
    // 501 songs with missing files, whose ids sort before the playable one's.
    await prisma.track.createMany({
        data: Array.from({ length: 501 }, (_, n) => song(`${P}-a-${String(n).padStart(4, "0")}`, `${WORDS} ${n}`, n, { missingSince: new Date() })),
    });
    await prisma.track.create({ data: song(PLAYABLE_ID, WORDS, 900) });
    await prisma.playlist.create({ data: { id: PLAYLIST, userId: USER, name: PLAYLIST } });
    await prisma.playlistPendingTrack.create({
        data: { playlistId: PLAYLIST, spotifyArtist: "Nobody Anyone", spotifyTitle: WORDS, spotifyAlbum: "x", sort: 0, rank: "a0" },
    });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

it("finds the song that plays among more than 500 missing songs with the same words", async () => {
    await playlistImportService.reconcilePendingTracks(PLAYLIST);
    const items = await prisma.playlistItem.findMany({ where: { playlistId: PLAYLIST } });
    expect(items.map((i) => i.trackId)).toEqual([PLAYABLE_ID]);
});
