/**
 * populateTrackGenres against the suite's real Postgres: songs of one album finishing at the
 * same moment with the same new genres all get them (a live 59-song run lost 5 songs to a
 * unique-constraint failure on Genre.name), and a later answer replaces the earlier set.
 */

import { prisma } from "../../utils/db";
import { trackIdentityService } from "../trackIdentity";

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const RUN = `tg${Date.now().toString(36)}`;
const id = (s: string) => `${RUN}-${s}`;
// Genre names no other test writes, so "new" really is new for this run.
const NEW_GENRES = [`${RUN} synthwave`, `${RUN} darksynth`, `${RUN} electronic`];

async function trackIds(count: number): Promise<string[]> {
    await prisma.artist.create({ data: { id: id("art"), name: "Perturbator", identityKey: id("a") } });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: `temp-${RUN}`, artistId: id("art"), title: "Dangerous Days", primaryType: "Album" },
    });
    const ids = Array.from({ length: count }, (_, i) => id(`t${i}`));
    await prisma.track.createMany({
        data: ids.map((trackId, i) => ({
            id: trackId,
            albumId: id("alb"),
            title: `Song ${i}`,
            trackNo: i + 1,
            duration: 200,
            filePath: `${RUN}/song-${i}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        })),
    });
    return ids;
}

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: RUN } } });
    await prisma.genre.deleteMany({ where: { name: { in: NEW_GENRES } } });
});

describe("populateTrackGenres", () => {
    it("gives every song the same new genres when they are saved at the same moment", async () => {
        const ids = await trackIds(8);

        // Different orders, as each recording's votes list them.
        const results = await Promise.allSettled(
            ids.map((trackId, i) =>
                trackIdentityService.populateTrackGenres(trackId, i % 2 ? [...NEW_GENRES].reverse() : NEW_GENRES),
            ),
        );

        expect(results.filter((r) => r.status === "rejected")).toEqual([]);
        expect(await prisma.genre.count({ where: { name: { in: NEW_GENRES } } })).toBe(3);
        for (const trackId of ids) {
            expect(await prisma.trackGenre.count({ where: { trackId } })).toBe(3);
        }
    });

    it("replaces a song's genres with a later answer's, and clears them for an answer with none", async () => {
        const trackId = id("t0");
        await trackIdentityService.populateTrackGenres(trackId, [NEW_GENRES[0]]);
        const names = async () =>
            (await prisma.trackGenre.findMany({ where: { trackId }, include: { genre: true } })).map((tg) => tg.genre.name);
        expect(await names()).toEqual([NEW_GENRES[0]]);

        await trackIdentityService.populateTrackGenres(trackId, []);
        expect(await names()).toEqual([]);
    });
});
