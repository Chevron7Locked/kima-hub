/**
 * Subsonic apps see only songs that can play: an album's song count, length and song list leave out songs whose file
 * is missing or unreadable, in every list and view, and an album with nothing playable is not listed. Real database,
 * real router.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import { libraryRouter } from "../library";
import { starredRouter } from "../starred";
import { searchRouter } from "../search";

const MARK = "zz-sub-playable";
const USER = `${MARK}-user`;
const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/", libraryRouter, starredRouter, searchRouter);
const ask = (path: string, query: Record<string, string> = {}) =>
    request(app).get(path).query({ u: USER, f: "json", ...query }).expect(200).then((r) => r.body["subsonic-response"]);

let artistId: string;
let albumId: string;
let goneAlbumId: string;

async function cleanup() {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    artistId = (await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist`, libraryAlbumCount: 2 } })).id;
    const album = (title: string) =>
        prisma.album.create({ data: { rgMbid: `${MARK}-${title}`, identityKey: `${MARK}-${title}`, primaryType: "Album", title: `${MARK} ${title}`, artistId, location: "LIBRARY", year: 2020 } });
    albumId = (await album("Album")).id;
    goneAlbumId = (await album("Gone")).id;
    const song = (album: string, n: number, extra: object = {}) =>
        prisma.track.create({
            data: { title: `${MARK} ${n}`, albumId: album, trackNo: n, duration: 100, mime: "FLAC", filePath: `/${MARK}/${album}/${n}.flac`, fileModified: new Date(), fileSize: 1, ...extra },
        });
    await song(albumId, 1);
    await song(albumId, 2, { missingSince: new Date() });
    await song(albumId, 3, { corrupt: true });
    const gone = await song(goneAlbumId, 1, { missingSince: new Date() });
    const good = await prisma.track.findFirstOrThrow({ where: { albumId, missingSince: null, corrupt: false } });
    for (const t of [good, gone]) {
        await prisma.play.create({ data: { userId: USER, trackId: t.id, playedAt: new Date() } });
        await prisma.likedTrack.create({ data: { userId: USER, trackId: t.id } });
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("an album's view counts and lists only the song that plays", async () => {
    const { album } = await ask("/getAlbum.view", { id: albumId });
    expect(album).toMatchObject({ songCount: 1, duration: 100 });
    expect(album.song).toHaveLength(1);

    const { directory } = await ask("/getMusicDirectory.view", { id: albumId });
    expect(directory.child).toHaveLength(1);
});

it("an artist's albums count only playable songs, and leave out an album with none", async () => {
    const { artist } = await ask("/getArtist.view", { id: artistId });
    expect(artist.album.map((a: { id: string; songCount: number }) => [a.id, a.songCount])).toEqual([[albumId, 1]]);
});

it.each(["newest", "random", "alphabeticalByName", "recent", "frequent", "starred"])("the %s album list counts only playable songs", async (type) => {
    const { albumList2 } = await ask("/getAlbumList2.view", { type, size: "500" });
    const ours = (albumList2.album ?? []).filter((a: { id: string }) => [albumId, goneAlbumId].includes(a.id));
    expect(ours.map((a: { id: string; songCount: number; duration: number }) => [a.id, a.songCount, a.duration])).toEqual([[albumId, 1, 100]]);
});

it("starred songs leave out a song that cannot play", async () => {
    const { starred2 } = await ask("/getStarred2.view");
    const titles = (starred2.song ?? []).map((t: { title: string }) => t.title).filter((t: string) => t.startsWith(MARK));
    expect(titles).toEqual([`${MARK} 1`]);
});

it("listing every album leaves out one with nothing to play", async () => {
    const { searchResult3 } = await ask("/search3.view", { query: "", albumCount: "500", artistCount: "0", songCount: "0" });
    const ids = (searchResult3.album ?? []).map((a: { id: string }) => a.id);
    expect(ids).toContain(albumId);
    expect(ids).not.toContain(goneAlbumId);
});
