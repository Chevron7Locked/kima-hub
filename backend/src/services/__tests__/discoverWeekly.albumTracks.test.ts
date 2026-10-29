/**
 * A week's Discover album is found by release-group id, by artist and title, or last by the artist's normalised name
 * (a credit like "Low & Friends" for "Low"); every way returns only songs whose files are there. Real database.
 */
import { prisma } from "../../utils/db";
import { discoverWeeklyService } from "../discoverWeekly";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-dw-tracks";

async function cleanup() {
    await prisma.track.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    const artist = await prisma.artist.create({ data: { name: `${P} low & friends`, identityKey: `${P}-artist` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-rg`, identityKey: `${P}-album`, primaryType: "Album", title: `${P} things we lost`, artistId: artist.id, location: "DISCOVER" },
    });
    const song = (n: number, extra: object = {}) =>
        prisma.track.create({ data: { title: `${P} ${n}`, albumId: album.id, trackNo: n, duration: 100, filePath: `/${P}/${n}.flac`, fileModified: new Date(), fileSize: 1, ...extra } });
    await song(1);
    await song(2, { missingSince: new Date() });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const find = (c: object) => (discoverWeeklyService as any).discoverAlbumTracks(c).then((ts: Array<{ title: string }>) => ts.map((t) => t.title));

it.each([
    ["the release-group id", { albumMbid: `${P}-rg` }],
    ["the artist's normalised name", { artistName: `${P} low`, albumTitle: `${P} things we lost` }],
])("by %s returns only the songs that are there", async (_how, c) => {
    expect(await find(c)).toEqual([`${P} 1`]);
});

it("finds nothing for another album", async () => {
    expect(await find({ artistName: `${P} low`, albumTitle: `${P} another album` })).toEqual([]);
});
