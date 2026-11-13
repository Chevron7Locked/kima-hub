/**
 * The More Like mix and Your Top 20 and Rediscover read plays through the listens module, each with the meaning it
 * had: More Like names the artist with the most plays in the last 7 days, counting every Play row of any library song
 * (a missing file's plays count, a Discover song's do not); Top 20 counts Play rows of playable songs; Rediscover
 * keeps songs played two times or fewer by this listener. Real test database; the similar-artist lookup is faked.
 */
const similarOf = jest.fn();
jest.mock("../../artistSimilarity", () => ({ getSimilarArtists: (...args: unknown[]) => similarOf(...args) }));

import { prisma } from "../../../utils/db";
import { generateArtistSimilarMix, generateRediscoverMix, generateTopTracksMix } from "../discoveryMixes";

jest.setTimeout(60_000);

const P = "mlm_";
const ME = `${P}me`;
const OTHER = `${P}other`;
const id = (s: string) => `${P}${s}`;
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

async function seedArtist(a: string, opts: { location?: "LIBRARY" | "DISCOVER"; songs: number; missing?: boolean }) {
    await prisma.artist.create({ data: { id: id(`art_${a}`), name: `More ${a}`, normalizedName: `more ${a}`, identityKey: id(`ak_${a}`) } });
    await prisma.album.create({
        data: {
            id: id(`alb_${a}`), rgMbid: id(`rg_${a}`), artistId: id(`art_${a}`), identityKey: id(`ik_${a}`),
            title: `More ${a}`, primaryType: "Album", location: opts.location ?? "LIBRARY",
        },
    });
    for (let i = 0; i < opts.songs; i++) {
        await prisma.track.create({
            data: {
                id: id(`${a}${i}`), albumId: id(`alb_${a}`), title: `${a}${i}`, trackNo: i + 1, duration: 200,
                filePath: `/tmp/${P}${a}${i}.flac`, fileModified: new Date(), fileSize: 1000,
                missingSince: opts.missing ? new Date() : null,
            },
        });
    }
}

let n = 0;
const play = (user: string, song: string, playedAt: Date) => ({ id: id(`play_${n++}`), userId: user, trackId: id(song), playedAt });
const times = (user: string, song: string, count: number, from = 1) =>
    Array.from({ length: count }, (_, k) => play(user, song, ago((from + k) * 60_000)));

beforeAll(async () => {
    await cleanup();
    for (const u of [ME, OTHER]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    await seedArtist("x", { songs: 6 }); // the top artist among the playable
    await seedArtist("y", { songs: 2 });
    await seedArtist("d", { songs: 1, location: "DISCOVER" });
    await seedArtist("m", { songs: 1, missing: true });
    await seedArtist("s", { songs: 8 }); // the similar artist the mix is drawn from
});

afterAll(cleanup);

afterEach(async () => {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    similarOf.mockReset();
});

describe("More Like", () => {
    beforeEach(() => similarOf.mockResolvedValue([{ name: "More s" }]));

    it("is named for the artist with the most plays in the last 7 days", async () => {
        await prisma.play.createMany({ data: [...times(ME, "x0", 3), ...times(ME, "y0", 1), ...times(ME, "x1", 2, 10)] });
        const mix = await generateArtistSimilarMix(ME);
        expect(mix?.name).toBe("More Like More x");
        expect(similarOf).toHaveBeenCalledWith(expect.anything(), "More x", 10);
    });

    it("ignores plays older than 7 days, a Discover song's plays, and other listeners' plays", async () => {
        await prisma.play.createMany({
            data: [
                ...times(ME, "y0", 1),
                ...[8, 9, 10].map((d) => play(ME, "x0", ago(d * DAY))),
                ...times(ME, "d0", 5),
                ...times(OTHER, "x0", 9),
            ],
        });
        expect((await generateArtistSimilarMix(ME))?.name).toBe("More Like More y");
    });

    it("counts a missing song's plays, as it always has", async () => {
        await prisma.play.createMany({ data: [...times(ME, "x0", 1), ...times(ME, "m0", 3)] });
        expect((await generateArtistSimilarMix(ME))?.name).toBe("More Like More m");
    });

    it("is none for a listener with no plays this week", async () => {
        await prisma.play.createMany({ data: [play(ME, "x0", ago(8 * DAY))] });
        expect(await generateArtistSimilarMix(ME)).toBeNull();
    });
});

describe("Your Top 20", () => {
    it("is the most played playable songs, most first, for this listener", async () => {
        await prisma.play.createMany({
            data: [
                ...times(ME, "x0", 6), ...times(ME, "x1", 5), ...times(ME, "x2", 4), ...times(ME, "x3", 3), ...times(ME, "x4", 2),
                // Played most of all, but a Discover song and a missing one.
                ...times(ME, "d0", 9), ...times(ME, "m0", 9),
                ...times(OTHER, "y0", 20),
            ],
        });
        const mix = await generateTopTracksMix(ME);
        expect(mix?.trackIds).toEqual([id("x0"), id("x1"), id("x2"), id("x3"), id("x4")]);
    });

    it("is none under five songs", async () => {
        await prisma.play.createMany({ data: times(ME, "x0", 3) });
        expect(await generateTopTracksMix(ME)).toBeNull();
    });
});

describe("Rediscover", () => {
    it("leaves out the songs this listener has played more than twice, and no one else's plays count", async () => {
        await prisma.play.createMany({ data: [...times(ME, "x0", 3), ...times(ME, "x1", 2), ...times(OTHER, "x2", 9)] });
        const mix = await generateRediscoverMix(ME, "2026-11-13");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).not.toContain(id("x0"));
        expect(mix!.trackIds).toEqual(expect.arrayContaining([id("x1"), id("x2")]));
        expect(mix!.trackIds).not.toContain(id("d0"));
        expect(mix!.trackIds).not.toContain(id("m0"));
    });
});
