/**
 * The hero image and the album-cover sweep both go through `artwork.ts`. The
 * sweep passes the artist's name with the release-group id, since the sources
 * need it to search Deezer. Failure and boundary paths first, happy path last.
 * Real database; the stored artist and album rows are what is checked.
 */

const mockFindLocalArtistImage = jest.fn().mockResolvedValue(null);

jest.mock("../../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../../utils/redis", () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        setex: jest.fn().mockResolvedValue("OK"),
        del: jest.fn().mockResolvedValue(1),
    },
}));

jest.mock("../../../services/wikidata", () => ({
    wikidataService: { getArtistInfo: jest.fn().mockResolvedValue(null) },
}));

const mockResolveByEntity = jest.fn().mockResolvedValue(true);
jest.mock("../../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: { resolveByEntity: (...a: unknown[]) => mockResolveByEntity(...a) },
}));

jest.mock("../../../services/artistSimilarity", () => ({
    getSimilarArtists: jest.fn().mockResolvedValue([]),
    findSimilarArtists: jest.fn().mockResolvedValue({ artists: [], failed: false }),
}));


const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

const mockSearchArtist = jest.fn();
const mockGetArtist = jest.fn();
jest.mock("../../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: (...a: unknown[]) => mockSearchArtist(...a),
        getArtist: (...a: unknown[]) => mockGetArtist(...a),
    },
}));

const mockFindAlbumArtwork = jest.fn();
const mockFindArtistArtwork = jest.fn();
jest.mock("../../../services/artwork", () => ({
    findAlbumArtwork: (...a: unknown[]) => mockFindAlbumArtwork(...a),
    findArtistArtwork: (...a: unknown[]) => mockFindArtistArtwork(...a),
}));

const mockDownloadAndStoreImage = jest.fn();
jest.mock("../../../services/imageStorage", () => ({
    downloadAndStoreImage: (...a: unknown[]) => mockDownloadAndStoreImage(...a),
    isNativePath: (p: string) => typeof p === "string" && p.startsWith("native:"),
    nativeFileExists: jest.fn().mockReturnValue(false),
    findLocalArtistImage: (...a: unknown[]) => mockFindLocalArtistImage(...a),
}));

import { enrichSimilarArtist } from "../artists";
import { prisma } from "../../../utils/db";
import { useShutdownCheck } from "../../../utils/stopCheck";
import { markerMoves, watchMarkerWrites } from "../../../__tests__/helpers/libraryMarker";
import { flushShownChanges } from "../../../services/shownChanges";

const P = "zz-artEnrich-";
const REAL_MBID = "11111111-2222-3333-4444-555555555555";
const HERO = "https://assets.fanart.tv/fanart/music/x/artistthumb/a.jpg";
const COVER = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";

async function wipe() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } }); // its similar-artist rows go too
}

/** An artist row (id `${P}${n}`) as the enrichment pass finds it; returns the row the worker is handed. */
async function seedArtist(
    n: string,
    data: { name?: string; mbid?: string | null; heroUrl?: string; summary?: string; enrichmentFailures?: number } = {},
) {
    const id = `${P}${n}`;
    return prisma.artist.create({
        data: { id, name: "Perturbator", identityKey: id, mbid: REAL_MBID, ...data },
    });
}

/** An album of the artist; its release-group id is `${P}rg-${n}`. */
const seedAlbum = (artistId: string, n: string, title: string, coverUrl: string | null) =>
    prisma.album.create({
        data: { id: `${P}alb-${n}`, artistId, title, identityKey: `${P}alb-${n}`, rgMbid: `${P}rg-${n}`, primaryType: "Album", coverUrl },
    });

const stored = (id: string) => prisma.artist.findUniqueOrThrow({ where: { id } });
const storedCover = async (n: string) => (await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb-${n}` } })).coverUrl;

beforeAll(wipe);
afterAll(wipe);

describe("the enrichment worker asks every source", () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        mockFindArtistArtwork.mockResolvedValue(null);
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
        mockFindLocalArtistImage.mockResolvedValue(null);
        mockSearchArtist.mockResolvedValue(answeredWith([]));
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Perturbator", "sort-name": "Perturbator", aliases: [] }));
    });

    describe("the artist's hero image", () => {
        it("records no image when no source had one", async () => {
            await enrichSimilarArtist(await seedArtist("1"));

            expect((await stored(`${P}1`)).heroUrl).toBeNull();
        });

        it("goes through the one door rather than Fanart-then-Deezer by hand", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "fanart" });

            await enrichSimilarArtist(await seedArtist("1"));

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: REAL_MBID,
            });
        });

        it("stores whatever image the one door found", async () => {
            // The door walks every source; the worker stores whatever it finds.
            mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "deezer" });
            mockDownloadAndStoreImage.mockResolvedValue("native:artists/art-1.jpg");

            await enrichSimilarArtist(await seedArtist("1"));

            expect((await stored(`${P}1`)).heroUrl).toBe("native:artists/art-1.jpg");
        });

        it("hands the image download a signal that aborts when the shutdown begins", async () => {
            mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "deezer" });
            let begun = false;
            useShutdownCheck(() => begun);
            let seen: AbortSignal | undefined;
            mockDownloadAndStoreImage.mockImplementation(async (_url, _id, _type, signal?: AbortSignal) => {
                seen = signal;
                begun = true;
                await new Promise((resolve) => setTimeout(resolve, 300));
                return null;
            });

            try {
                await enrichSimilarArtist(await seedArtist("1"));
                expect(seen).toBeInstanceOf(AbortSignal);
                expect(seen!.aborted).toBe(true);
            } finally {
                useShutdownCheck(() => false);
            }
        });

        it("does not hand a placeholder MBID to the sources", async () => {
            // A "temp-" id is kept when MusicBrainz is unreachable; Fanart would
            // 404 on it. The service answers a timeout with `transient`.
            mockSearchArtist.mockResolvedValue({
                kind: "transient",
                error: { code: "TIMEOUT", message: "MusicBrainz timed out" },
            });
            mockFindArtistArtwork.mockResolvedValue(null);

            await enrichSimilarArtist(await seedArtist("1", { mbid: `temp-${P}9` }));

            expect(mockFindArtistArtwork).toHaveBeenCalledWith({
                name: "Perturbator",
                mbid: undefined,
            });
        });
    });

    describe("the album-cover sweep", () => {
        /** The artist, with one album that has no cover. */
        async function arrangeUncovered() {
            const artist = await seedArtist("1");
            await seedAlbum(artist.id, "1", "Dangerous Days", null);
            return artist;
        }

        it("passes the artist's name, so Deezer can actually be searched", async () => {
            // With only a release-group id the sources can ask the archive and
            // nothing else.
            await enrichSimilarArtist(await arrangeUncovered());

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: `${P}rg-1`,
                artistName: "Perturbator",
                albumTitle: "Dangerous Days",
            });
        });

        it("stores whatever any source found", async () => {
            mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });

            await enrichSimilarArtist(await arrangeUncovered());

            expect(await storedCover("1")).toBe(COVER);
        });

        it("writes nothing for an album no source had", async () => {
            await enrichSimilarArtist(await arrangeUncovered());

            expect(await storedCover("1")).toBeNull();
        });

        it("still tries for an album whose id this app invented", async () => {
            // The id-keyed sources skip themselves; Deezer does not need an id.
            const artist = await seedArtist("1");
            await prisma.album.create({
                data: {
                    id: `${P}alb-2`, artistId: artist.id, title: "Unscanned", identityKey: `${P}alb-2`,
                    rgMbid: `temp-${P}7`, primaryType: "Album",
                },
            });

            await enrichSimilarArtist(artist);

            expect(mockFindAlbumArtwork).toHaveBeenCalledWith({
                rgMbid: `temp-${P}7`,
                artistName: "Perturbator",
                albumTitle: "Unscanned",
            });
        });

        it("leaves an album that already has a cover alone", async () => {
            const artist = await seedArtist("1");
            await seedAlbum(artist.id, "3", "Covered", "https://x/y.jpg");
            mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });

            await enrichSimilarArtist(artist);

            expect(mockFindAlbumArtwork).not.toHaveBeenCalled();
            expect(await storedCover("3")).toBe("https://x/y.jpg");
        });
    });
});

describe("an artist row holding another artist's MusicBrainz id", () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        mockFindArtistArtwork.mockResolvedValue(null);
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockFindLocalArtistImage.mockResolvedValue(null);
        mockSearchArtist.mockResolvedValue(answeredWith([]));
    });

    /** `fromId` is similar to a second artist, so the similar-artist row can be seen kept or dropped. */
    async function seedSimilarTo(fromId: string) {
        const other = await seedArtist("other", { name: "Someone Else", mbid: null });
        await prisma.similarArtist.create({ data: { fromArtistId: fromId, toArtistId: other.id, weight: 0.5 } });
    }
    const similarCount = (fromId: string) => prisma.similarArtist.count({ where: { fromArtistId: fromId } });

    it("drops the id and what it brought when MusicBrainz names someone else (Alexis Ffrench holding Sam Cooke's)", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Sam Cooke", "sort-name": "Cooke, Sam", aliases: [] }));
        mockFindLocalArtistImage.mockResolvedValue("native:artists/art-2.jpg");
        const artist = await seedArtist("2", { name: "Alexis Ffrench", heroUrl: "native:artists/art-2.jpg", summary: "Sam Cooke's bio" });
        await seedSimilarTo(artist.id);
        const album = await seedAlbum(artist.id, "1", "Dreams", "https://x/y.jpg");
        await prisma.track.create({
            data: { id: `${P}t1`, albumId: album.id, title: "T", trackNo: 1, duration: 100, filePath: `/m/${P}t1.flac`, fileModified: new Date(), fileSize: 1 },
        });

        await enrichSimilarArtist(artist);

        const row = await stored(artist.id);
        expect(row.mbid).toBeNull();
        expect(row.summary).toBeNull();
        expect(row.heroUrl).toBe("native:artists/art-2.jpg");
        expect(await similarCount(artist.id)).toBe(0);
    });

    it("keeps the id when MusicBrainz's name or an alias is this artist", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "deadmau5", "sort-name": "deadmau5", aliases: [{ name: "Deadmau5" }] }));
        const artist = await seedArtist("3", { name: "Deadmau5" });

        await enrichSimilarArtist(artist);

        expect((await stored(artist.id)).mbid).toBe(REAL_MBID);
    });

    it.each([
        ["accents and punctuation differ", "Sigur Ros", { name: "Sigur Rós", "sort-name": "Sigur Rós", aliases: [] }],
        ["the library uses the sort form", "Glass, Philip", { name: "Philip Glass", "sort-name": "Glass, Philip", aliases: [] }],
        ["only a transliterated alias matches", "Mumiy Troll", { name: "Мумий Тролль", "sort-name": "Mumiy Troll", aliases: [{ name: "Mumiy Troll" }] }],
        ["the library drops a leading article", "Beatles", { name: "The Beatles", "sort-name": "Beatles, The", aliases: [] }],
    ])("keeps a right id when %s", async (_case, local, held) => {
        mockGetArtist.mockResolvedValue(answeredWith(held));
        const artist = await seedArtist("5", { name: local });
        await seedSimilarTo(artist.id);

        await enrichSimilarArtist(artist);

        expect((await stored(artist.id)).mbid).toBe(REAL_MBID);
        expect(await similarCount(artist.id)).toBe(1);
    });

    it("leaves the row alone while MusicBrainz is unreachable", async () => {
        mockGetArtist.mockResolvedValue({ kind: "transient", error: { code: "NETWORK", message: "down" } });
        jest.requireMock("../../../services/wikidata").wikidataService.getArtistInfo.mockResolvedValueOnce({});
        const artist = await seedArtist("4");
        await seedSimilarTo(artist.id);

        await enrichSimilarArtist(artist);

        const row = await stored(artist.id);
        expect(row.mbid).toBe(REAL_MBID);
        expect(await similarCount(artist.id)).toBe(1);
        // The unanswered question counts as a failed try; it is not stored as done.
        expect(row.enrichmentStatus).toBe("failed");
        expect(row.enrichmentFailures).toBe(1);
    });

    it("waits for MusicBrainz's rate limit without counting a failure or calling the artist done", async () => {
        mockGetArtist.mockResolvedValue({ kind: "rateLimited", retryAfter: new Date(Date.now() + 5000), evidence: {} });
        jest.requireMock("../../../services/wikidata").wikidataService.getArtistInfo.mockResolvedValueOnce({});

        const artist = await seedArtist("6", { enrichmentFailures: 2 });
        await enrichSimilarArtist(artist);

        const row = await stored(artist.id);
        expect(row.enrichmentStatus).toBe("pending");
        expect(row.enrichmentFailures).toBe(2);
    });

    it("clears the artist's earlier failures from the failures list once it is answered", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Perturbator", "sort-name": "Perturbator", aliases: [], genres: [] }));
        jest.requireMock("../../../services/wikidata").wikidataService.getArtistInfo.mockResolvedValueOnce({});

        const artist = await seedArtist("7", { enrichmentFailures: 2 });
        await enrichSimilarArtist(artist);

        const row = await stored(artist.id);
        expect(row.enrichmentStatus).toBe("completed");
        expect(row.enrichmentFailures).toBe(0);
        expect(mockResolveByEntity).toHaveBeenCalledWith("artist", artist.id);
    });
});

/**
 * A picture the worker finds or replaces for a listed artist or album is a change a Subsonic client shows: the library marker
 * moves once (services/shownChanges.ts), and only when what is shown really changed. Real database, real marker.
 */
describe("the enrichment worker's found pictures and the library marker", () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await wipe();
        await flushShownChanges();
        mockFindArtistArtwork.mockResolvedValue(null);
        mockFindAlbumArtwork.mockResolvedValue(null);
        mockDownloadAndStoreImage.mockResolvedValue(null);
        mockFindLocalArtistImage.mockResolvedValue(null);
        mockSearchArtist.mockResolvedValue(answeredWith([]));
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Perturbator", "sort-name": "Perturbator", aliases: [] }));
        // A stored native picture is on disk, as it is for a real library.
        jest.requireMock("../../../services/imageStorage").nativeFileExists.mockReturnValue(true);
    });
    afterAll(async () => {
        jest.requireMock("../../../services/imageStorage").nativeFileExists.mockReturnValue(false);
        await flushShownChanges();
    });

    /** The artist with one album (cover `coverUrl`) and one song on it; `location` DISCOVER makes it a Discover album no client lists. */
    async function arrange(coverUrl: string | null, location: "LIBRARY" | "DISCOVER" = "LIBRARY", artistData: { heroUrl?: string; userHeroUrl?: string } = {}) {
        const artist = await seedArtist("1", artistData);
        const album = await seedAlbum(artist.id, "1", "Dangerous Days", coverUrl);
        await prisma.album.update({ where: { id: album.id }, data: { location } });
        await prisma.track.create({
            data: { id: `${P}t1`, albumId: album.id, title: "T", trackNo: 1, duration: 100, filePath: `/m/${P}t1.flac`, fileModified: new Date(), fileSize: 1 },
        });
        return artist;
    }
    const enrichAndFlush = (artist: Awaited<ReturnType<typeof seedArtist>>) =>
        markerMoves(async () => {
            await enrichSimilarArtist(artist);
            await flushShownChanges();
        });

    it("moves the marker when an artist image is found", async () => {
        mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "fanart" });
        mockDownloadAndStoreImage.mockResolvedValue("native:artists/art-1.jpg");
        expect(await enrichAndFlush(await arrange("https://x/y.jpg"))).toBe(true);
    });

    it("moves the marker once when an artist image and several album covers are found", async () => {
        mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "fanart" });
        mockDownloadAndStoreImage.mockResolvedValue("native:artists/art-1.jpg");
        mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });
        const artist = await arrange(null);
        const writes = watchMarkerWrites();
        await enrichSimilarArtist(artist);
        await flushShownChanges();
        const moves = writes.count();
        writes.restore();
        expect(moves).toBe(1);
    });

    it("moves the marker when an album cover is found", async () => {
        mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });
        expect(await enrichAndFlush(await arrange(null))).toBe(true);
    });

    it("leaves the marker when nothing was found", async () => {
        expect(await enrichAndFlush(await arrange("https://x/y.jpg"))).toBe(false);
    });

    it("leaves the marker when the artist's own picture shows either way", async () => {
        mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "fanart" });
        mockDownloadAndStoreImage.mockResolvedValue("native:artists/art-1.jpg");
        expect(await enrichAndFlush(await arrange("https://x/y.jpg", "LIBRARY", { userHeroUrl: "native:artists/mine.jpg" }))).toBe(false);
    });

    it("leaves the marker for a Discover album, which no client lists", async () => {
        mockFindArtistArtwork.mockResolvedValue({ url: HERO, source: "fanart" });
        mockDownloadAndStoreImage.mockResolvedValue("native:artists/art-1.jpg");
        mockFindAlbumArtwork.mockResolvedValue({ url: COVER, source: "deezer" });
        expect(await enrichAndFlush(await arrange(null, "DISCOVER"))).toBe(false);
    });

    it("moves the marker when dropping another artist's id puts a different local picture in", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Sam Cooke", "sort-name": "Cooke, Sam", aliases: [] }));
        mockFindLocalArtistImage.mockResolvedValue("native:artists/folder.jpg");
        expect(await enrichAndFlush(await arrange("https://x/y.jpg", "LIBRARY", { heroUrl: "https://old/hero.jpg" }))).toBe(true);
        expect((await stored(`${P}1`)).heroUrl).toBe("native:artists/folder.jpg");
    });

    it("leaves the marker when dropping another artist's id keeps the same picture", async () => {
        mockGetArtist.mockResolvedValue(answeredWith({ name: "Sam Cooke", "sort-name": "Cooke, Sam", aliases: [] }));
        mockFindLocalArtistImage.mockResolvedValue("native:artists/folder.jpg");
        expect(await enrichAndFlush(await arrange("https://x/y.jpg", "LIBRARY", { heroUrl: "native:artists/folder.jpg" }))).toBe(false);
    });

    describe("the genres it finds", () => {
        const knownAs = (...names: string[]) =>
            mockGetArtist.mockResolvedValue(
                answeredWith({ name: "Perturbator", "sort-name": "Perturbator", aliases: [], genres: names.map((name, i) => ({ name, count: 10 - i })) }),
            );
        const setGenres = (data: { genres?: string[]; userGenres?: string[] }) => prisma.artist.update({ where: { id: `${P}1` }, data });

        it("moves the marker when genres are found for an artist that had none", async () => {
            knownAs("synthwave", "darksynth");
            expect(await enrichAndFlush(await arrange("https://x/y.jpg"))).toBe(true);
            expect((await stored(`${P}1`)).genres).toEqual(["synthwave", "darksynth"]);
        });

        it("moves the marker when the genres found differ from the ones stored, in list or order", async () => {
            knownAs("darksynth", "synthwave");
            const artist = await arrange("https://x/y.jpg");
            await setGenres({ genres: ["synthwave", "darksynth"] });
            expect(await enrichAndFlush(artist)).toBe(true);
        });

        it("leaves the marker when the genres found are the ones stored", async () => {
            knownAs("synthwave", "darksynth");
            const artist = await arrange("https://x/y.jpg");
            await setGenres({ genres: ["synthwave", "darksynth"] });
            expect(await enrichAndFlush(artist)).toBe(false);
        });

        it("leaves the marker when the person's own genres show either way", async () => {
            knownAs("synthwave");
            const artist = await arrange("https://x/y.jpg");
            await setGenres({ userGenres: ["horrorsynth"] });
            expect(await enrichAndFlush(artist)).toBe(false);
        });

        it("leaves the marker when no genres were found", async () => {
            expect(await enrichAndFlush(await arrange("https://x/y.jpg"))).toBe(false);
        });

        it("leaves the marker for an artist no client lists (a Discover album only)", async () => {
            knownAs("synthwave");
            expect(await enrichAndFlush(await arrange("https://x/y.jpg", "DISCOVER"))).toBe(false);
        });

        it("moves the marker when dropping another artist's id takes the genres it brought away", async () => {
            mockGetArtist.mockResolvedValue(answeredWith({ name: "Sam Cooke", "sort-name": "Cooke, Sam", aliases: [] }));
            const artist = await arrange("https://x/y.jpg");
            await setGenres({ genres: ["soul"] });
            expect(await enrichAndFlush(await prisma.artist.findUniqueOrThrow({ where: { id: artist.id } }))).toBe(true);
            expect((await stored(`${P}1`)).genres).toBeNull();
        });
    });
});
