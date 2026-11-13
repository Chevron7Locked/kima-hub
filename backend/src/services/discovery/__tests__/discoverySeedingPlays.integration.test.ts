/**
 * Which plays seed Discover, on the real database: the listener's plays of songs on library albums. Plays of Discover
 * songs are plays too, but they say nothing of what the listener keeps, so they must not take seed slots from the songs
 * that do. Plays carry no Discover label; the album's location decides.
 */
import { prisma } from "../../../utils/db";
import { DiscoverySeeding } from "../discoverySeeding";

jest.setTimeout(60_000);

const P = "dsp_";
const USER = `${P}user`;
const LIBRARY_SONGS = 5;
// More Discover songs than the seeding keeps, each played more than any library song.
const DISCOVER_SONGS = 60;

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

async function artist(key: string) {
    await prisma.artist.create({
        data: { id: `${P}ar_${key}`, name: `Dsp ${key}`, normalizedName: `dsp ${key}`, identityKey: `${P}ak_${key}`, mbid: `${P}mbid-${key}` },
    });
}

async function song(key: string, location: "LIBRARY" | "DISCOVER", artistKey: string, plays: number) {
    await prisma.album.create({
        data: { id: `${P}al_${key}`, rgMbid: `${P}rg_${key}`, artistId: `${P}ar_${artistKey}`, identityKey: `${P}ik_${key}`, title: key, primaryType: "Album", location },
    });
    await prisma.track.create({
        data: { id: `${P}t_${key}`, albumId: `${P}al_${key}`, title: key, trackNo: 1, duration: 100, filePath: `${P}${key}.flac`, fileModified: new Date(), fileSize: 1 },
    });
    await prisma.play.createMany({
        data: Array.from({ length: plays }, (_, i) => ({
            id: `${P}p_${key}_${i}`,
            userId: USER,
            trackId: `${P}t_${key}`,
            playedAt: new Date(Date.now() - (i + 1) * 3_600_000),
        })),
    });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    for (let i = 0; i < LIBRARY_SONGS; i++) {
        await artist(`lib${i}`);
        await song(`lib${i}`, "LIBRARY", `lib${i}`, 5);
    }
    await artist("disc");
    for (let i = 0; i < DISCOVER_SONGS; i++) await song(`disc${i}`, "DISCOVER", "disc", 6);
    // A library artist nobody played, with the most albums: the library fallback would pick it first.
    await artist("big");
    for (let i = 0; i < 3; i++) await song(`big${i}`, "LIBRARY", "big", 0);
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("seeds from the songs on library albums, however many plays Discover songs have", async () => {
    const seeds = await new DiscoverySeeding().getSeedArtists(USER, 10);
    expect(seeds.map((s) => s.name).sort()).toEqual([0, 1, 2, 3, 4].map((i) => `Dsp lib${i}`));
});
