/**
 * Random Discovery draws 10 library albums, each by a different artist. An album whose only songs a scan marked corrupt
 * has nothing to play, so it must not be one of the ten: with 9 albums that can play and 5 that cannot, the mix has
 * too few albums and is not made. Real database.
 */
import { prisma } from "../../../utils/db";
import { generateRandomDiscoveryMix } from "../discoveryMixes";

jest.setTimeout(120_000);
const P = "zz_rdel_";

async function album(key: string, corrupt: boolean) {
    await prisma.artist.create({ data: { id: `${P}ar_${key}`, name: `${P}${key}`, identityKey: `${P}ar_${key}` } });
    await prisma.album.create({
        data: { id: `${P}alb_${key}`, rgMbid: `${P}rg_${key}`, artistId: `${P}ar_${key}`, identityKey: `${P}ik_${key}`, title: `${P}${key}`, primaryType: "Album", location: "LIBRARY" },
    });
    for (let i = 0; i < 3; i++) {
        const id = `${P}trk_${key}_${i}`;
        await prisma.track.create({
            data: { id, albumId: `${P}alb_${key}`, title: `${key} ${i}`, trackNo: i + 1, duration: 200, filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000, corrupt },
        });
    }
}

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    for (let i = 0; i < 9; i++) await album(`ok${i}`, false);
    for (let i = 0; i < 5; i++) await album(`bad${i}`, true);
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("an album with only corrupt songs is not one of the ten, so nine playable albums give no mix", async () => {
    for (let d = 1; d <= 5; d++) {
        const mix = await generateRandomDiscoveryMix("zz_rdel_user", `2026-08-0${d}`);
        expect(mix).toBeNull();
    }
});
