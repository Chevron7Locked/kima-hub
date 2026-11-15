/**
 * The stats page's "where plays came from" split, on the real database. Plays carry only LIBRARY or SUBSONIC; a play of a
 * song on a Discover album is in no segment (Kevin, 2026-11-15: statistics count library plays only), so neither the
 * split nor any other figure shows it.
 */
import { prisma } from "../../../utils/db";
import { listeningStats } from "../listening";
import { withListens } from "../listens";

jest.setTimeout(60_000);

const P = "lss_";
const USER = `${P}user`;

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

async function song(key: string, location: "LIBRARY" | "DISCOVER") {
    await prisma.artist.create({
        data: { id: `${P}ar_${key}`, name: `Lss ${key}`, normalizedName: `lss ${key}`, identityKey: `${P}ak_${key}` },
    });
    await prisma.album.create({
        data: { id: `${P}al_${key}`, rgMbid: `${P}rg_${key}`, artistId: `${P}ar_${key}`, identityKey: `${P}ik_${key}`, title: key, primaryType: "Album", location },
    });
    await prisma.track.create({
        data: { id: `${P}t_${key}`, albumId: `${P}al_${key}`, title: key, trackNo: 1, duration: 200, filePath: `${P}${key}.flac`, fileModified: new Date(), fileSize: 1 },
    });
}

const play = (id: string, key: string, source: "LIBRARY" | "SUBSONIC", hoursAgo: number) => ({
    id: `${P}p_${id}`,
    userId: USER,
    trackId: `${P}t_${key}`,
    source,
    playedAt: new Date(Date.now() - hoursAgo * 3_600_000),
});

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await song("lib", "LIBRARY");
    await song("disc", "DISCOVER");
    await prisma.play.createMany({
        data: [
            play("l1", "lib", "LIBRARY", 30),
            play("l2", "lib", "LIBRARY", 20),
            play("s1", "lib", "SUBSONIC", 10),
            play("d1", "disc", "LIBRARY", 5),
        ],
    });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("leaves a play of a Discover song out of the split, and out of the library segment", async () => {
    const stats = await withListens(USER, "all", (l) => listeningStats(l, "UTC"));
    expect(stats.bySource).toEqual({ LIBRARY: 2, SUBSONIC: 1 });
    expect(stats.plays).toBe(3);
});
