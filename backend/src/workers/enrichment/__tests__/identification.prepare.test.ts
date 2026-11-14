/**
 * Before the songs go out, identification asks AcoustID about them in batches and then names their untagged albums,
 * through `prepareIdentification` alone and no scheduler. Neither step may hold anything back: a failure is
 * logged and the other still runs.
 */

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const calls: string[] = [];
const mockPrefetch = jest.fn();
const mockIdentifyAlbums = jest.fn();
jest.mock("../../../services/acoustidIdentification", () => ({
    ...jest.requireActual("../../../services/acoustidIdentification"),
    prefetchAcoustidReplies: (...args: unknown[]) => {
        calls.push("acoustid");
        return mockPrefetch(...args);
    },
}));
jest.mock("../../../services/albumIdentification", () => ({
    ...jest.requireActual("../../../services/albumIdentification"),
    identifyAlbumsBySound: (...args: unknown[]) => {
        calls.push("albums");
        return mockIdentifyAlbums(...args);
    },
}));

import { prisma } from "../../../utils/db";
import { IDENTIFICATION_LOOKAHEAD, prepareIdentification } from "../identification";

const PREFIX = "idprep";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedAlbumWithTracks(album: string, tracks: string[]): Promise<void> {
    await prisma.artist.upsert({
        where: { id: id("art") },
        update: {},
        create: { id: id("art"), name: "IdPrep Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id(album), rgMbid: id(`rg_${album}`), artistId: id("art"), title: `IdPrep ${album}`, identityKey: id(`k_${album}`), primaryType: "Album" },
    });
    for (const t of tracks) {
        await prisma.track.create({
            data: {
                id: id(t),
                albumId: id(album),
                title: `Track ${t}`,
                trackNo: 1,
                duration: 200,
                filePath: `artist/${album}/${t}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            } as never,
        });
    }
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

beforeEach(async () => {
    jest.clearAllMocks();
    calls.length = 0;
    mockPrefetch.mockResolvedValue(0);
    mockIdentifyAlbums.mockResolvedValue([]);
    await wipe();
});

afterAll(async () => {
    await wipe();
});

describe("prepareIdentification", () => {
    it("looks 100 songs ahead", () => {
        expect(IDENTIFICATION_LOOKAHEAD).toBe(100);
    });

    it("asks AcoustID about the coming songs, then names their albums, each album once in the order its songs go out", async () => {
        await seedAlbumWithTracks("albA", ["a1", "a2"]);
        await seedAlbumWithTracks("albB", ["b1"]);

        await prepareIdentification([{ trackId: id("b1") }, { trackId: id("a1") }, { trackId: id("a2") }]);

        expect(calls).toEqual(["acoustid", "albums"]);
        const asked = mockPrefetch.mock.calls[0][0] as Array<{ id: string }>;
        expect(asked.map((t) => t.id).sort()).toEqual([id("a1"), id("a2"), id("b1")]);
        expect(mockIdentifyAlbums).toHaveBeenCalledWith([id("albB"), id("albA")]);
    });

    it("asks AcoustID about nothing when no songs are coming, and still lets the album step run", async () => {
        await prepareIdentification([]);

        expect(mockPrefetch).not.toHaveBeenCalled();
        expect(mockIdentifyAlbums).toHaveBeenCalledWith([]);
    });

    it("carries on to the albums when AcoustID cannot be asked", async () => {
        await seedAlbumWithTracks("albA", ["a1"]);
        mockPrefetch.mockRejectedValue(new Error("AcoustID unreachable"));

        await expect(prepareIdentification([{ trackId: id("a1") }])).resolves.toBeUndefined();

        expect(mockIdentifyAlbums).toHaveBeenCalledWith([id("albA")]);
    });

    it("returns when the album step fails", async () => {
        await seedAlbumWithTracks("albA", ["a1"]);
        mockIdentifyAlbums.mockRejectedValue(new Error("MusicBrainz unreachable"));

        await expect(prepareIdentification([{ trackId: id("a1") }])).resolves.toBeUndefined();

        expect(mockPrefetch).toHaveBeenCalledTimes(1);
    });
});
