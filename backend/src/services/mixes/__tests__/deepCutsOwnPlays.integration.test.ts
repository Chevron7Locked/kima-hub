/**
 * Deep Cuts is the listener's own: a song is a deep cut when THIS listener has not played it (or, when fewer than 15
 * such songs exist, has listened to it three times or fewer, counted as stats/listens.ts counts listens). Another
 * user's plays do not make a song stop being one. Real test database.
 */
import { prisma } from "../../../utils/db";
import { generateDeepCuts } from "../moodMixes";

jest.setTimeout(120_000);

const P = "dco_";
const A = `${P}a`;
const B = `${P}b`;
const SONGS = 16;
const DAY = "2026-11-01";
const trk = (i: number) => `${P}trk_${String(i).padStart(3, "0")}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

/** `n` listens of song `song` by `user`, a day apart so each is its own listen. */
const listens = (user: string, song: number, n: number, tag: string) =>
    Array.from({ length: n }, (_, k) => ({ id: `${P}${tag}_${user}_${song}_${k}`, userId: user, trackId: trk(song), playedAt: daysAgo(k + 1), heard: true }));

beforeAll(async () => {
    await cleanup();
    for (const u of [A, B]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    await prisma.artist.create({ data: { id: `${P}art`, name: "Deep Artist", normalizedName: "deep artist", identityKey: `${P}ak` } });
    await prisma.album.create({
        data: { id: `${P}alb`, rgMbid: `${P}rg`, artistId: `${P}art`, identityKey: `${P}ik`, title: "Deep Album", primaryType: "Album" },
    });
    await prisma.$executeRaw`
        INSERT INTO "Track" (id, "albumId", title, "trackNo", duration, "filePath", "fileModified", "fileSize", corrupt, "updatedAt")
        SELECT ${P + "trk_"} || lpad(i::text, 3, '0'), ${P + "alb"}, 'Deep Track ' || i, 1, 200,
               '/tmp/' || ${P} || i || '.flac', now(), 1000, false, now()
        FROM generate_series(0, ${SONGS - 1}) AS i`;
});

afterAll(cleanup);

afterEach(async () => {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
});

const ids = async (user: string) => (await generateDeepCuts(user, DAY))?.trackIds ?? [];

it("a song A played five times is still unplayed for B", async () => {
    await prisma.play.createMany({ data: listens(A, 0, 5, "p") });
    const forA = await ids(A);
    const forB = await ids(B);
    expect(forA).not.toContain(trk(0));
    expect(forA).toHaveLength(SONGS - 1);
    expect(forB).toContain(trk(0));
    expect(forB).toHaveLength(SONGS);
});

it("when the listener has played everything, listens of three or fewer are counted for them alone", async () => {
    const data = [];
    for (let i = 0; i < SONGS; i++) {
        data.push(...listens(A, i, i === 0 ? 5 : 1, "all"), ...listens(B, i, 1, "all"));
    }
    await prisma.play.createMany({ data });
    // A listened to song 0 five times: not a deep cut. B listened once: still one, whatever A did.
    const forA = await ids(A);
    const forB = await ids(B);
    expect(forA).not.toContain(trk(0));
    expect(forA).toHaveLength(SONGS - 1);
    expect(forB).toContain(trk(0));
    expect(forB).toHaveLength(SONGS);
});
