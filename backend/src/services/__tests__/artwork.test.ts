/**
 * `artwork.ts` asks every source in turn until one answers; a placeholder only
 * when all say no. Failure and boundary paths first, happy path last.
 */

const mockGet = jest.fn();
const mockSetex = jest.fn();

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: (...a: unknown[]) => mockGet(...a),
        setex: (...a: unknown[]) => mockSetex(...a),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../../utils/ssrf", () => {
    // Address checking has its own test (ssrfRedirects). Here an address written as an internal IP is refused by
    // the real rule, with no name lookups, and everything else goes to the spied fetch.
    const actual = jest.requireActual("../../utils/ssrf");
    return {
        ...actual,
        fetchChecked: async (url: string, init?: RequestInit) => {
            const host = new URL(url).hostname;
            if (require("net").isIP(host) && actual.isBlockedIp(host)) throw new actual.BlockedAddressError("Blocked: internal address");
            return fetch(url, init);
        },
    };
});

const deezerAlbum = jest.fn();
const deezerArtist = jest.fn();
jest.mock("../deezer", () => ({
    deezerService: {
        getAlbumCover: (...a: unknown[]) => deezerAlbum(...a),
        getArtistImage: (...a: unknown[]) => deezerArtist(...a),
    },
}));

const archiveCover = jest.fn();
jest.mock("../coverArt", () => ({
    coverArtService: { getCoverArt: (...a: unknown[]) => archiveCover(...a) },
}));

const fanartAlbum = jest.fn();
const fanartArtist = jest.fn();
jest.mock("../fanart", () => ({
    fanartService: {
        getAlbumCover: (...a: unknown[]) => fanartAlbum(...a),
        getArtistImage: (...a: unknown[]) => fanartArtist(...a),
    },
}));

import { findAlbumArtwork, findArtistArtwork, withAlbumArtwork, withArtistArtwork } from "../artwork";

const DEEZER_URL = "https://e-cdns-images.dzcdn.net/images/cover/abc/500x500.jpg";
const ARCHIVE_URL = "https://coverartarchive.org/release-group/10e85e9b-0f07-33d4-a927-18a273f86eca/front-1200.jpg";
const FANART_URL = "https://assets.fanart.tv/fanart/music/xyz/albumcover/a.jpg";
/** An unchecked Cover Art Archive address, built from the MBID alone. */
const GUESS = "https://coverartarchive.org/release-group/10e85e9b-0f07-33d4-a927-18a273f86eca/front-500";

const ALBUM = { rgMbid: "10e85e9b-0f07-33d4-a927-18a273f86eca", artistName: "Brad Sucks", albumTitle: "I Don't Know What I'm Doing" };
const ARTIST = { name: "Brad Sucks", mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55" };

describe("the one door for artwork", () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGet.mockResolvedValue(null);
        mockSetex.mockResolvedValue("OK");
        for (const m of [deezerAlbum, deezerArtist, archiveCover, fanartAlbum, fanartArtist]) {
            m.mockResolvedValue(null);
        }
        fetchSpy = jest
            .spyOn(globalThis, "fetch")
            .mockImplementation((async () =>
                ({ ok: false, status: 404 }) as unknown as Response) as never);
    });

    let clock: jest.SpyInstance | undefined;
    afterEach(() => {
        fetchSpy.mockRestore();
        clock?.mockRestore();
        clock = undefined;
    });

    /** Every clock read after the first is 3 s on, so the page's wait for unknown covers is already over. */
    const pastTheBudget = () => {
        const start = Date.now();
        let reads = 0;
        clock = jest.spyOn(Date, "now").mockImplementation(() => start + (reads++ === 0 ? 0 : 3_000));
    };

    /**
     * A page that stops waiting leaves its lookup running, and that lookup then checks the candidate address with
     * fetch. Asking for the same record joins the lookup still in flight, so the test ends only once it has finished
     * against the spied fetch, never the real one after this file is done.
     */
    const outlivedLookup = () => findAlbumArtwork({ ...ALBUM, candidateUrl: GUESS });

    describe("album covers", () => {
        it("keeps asking after the first source comes up empty", async () => {
            // The whole point. dataCache, musicScanner, artistEnrichment and
            // the cover-art route each stopped after one source.
            archiveCover.mockResolvedValue(ARCHIVE_URL);

            const found = await findAlbumArtwork(ALBUM);

            expect(deezerAlbum).toHaveBeenCalled();
            expect(found).toEqual({ url: ARCHIVE_URL, source: "coverartarchive" });
        });

        it("goes all the way to the last source rather than giving up", async () => {
            fanartAlbum.mockResolvedValue(FANART_URL);

            const found = await findAlbumArtwork(ALBUM);

            expect(found?.url).toBe(FANART_URL);
        });

        it("carries on past a source that throws", async () => {
            deezerAlbum.mockRejectedValue(new Error("Deezer is down"));
            archiveCover.mockResolvedValue(ARCHIVE_URL);

            const found = await findAlbumArtwork(ALBUM);

            expect(found?.url).toBe(ARCHIVE_URL);
        });

        it("stops at the first source that answers", async () => {
            deezerAlbum.mockResolvedValue(DEEZER_URL);
            archiveCover.mockResolvedValue(ARCHIVE_URL);

            const found = await findAlbumArtwork(ALBUM);

            expect(found).toEqual({ url: DEEZER_URL, source: "deezer" });
            expect(archiveCover).not.toHaveBeenCalled();
        });

        it("returns nothing when every source has said no", async () => {
            expect(await findAlbumArtwork(ALBUM)).toBeNull();
        });

        it("skips the sources that need a release-group id when there is none", async () => {
            await findAlbumArtwork({ artistName: "Soen", albumTitle: "Reliance" });

            expect(deezerAlbum).toHaveBeenCalled();
            expect(archiveCover).not.toHaveBeenCalled();
            expect(fanartAlbum).not.toHaveBeenCalled();
        });

        it("prefers a real source over an address it was handed", async () => {
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            const found = await findAlbumArtwork({ ...ALBUM, candidateUrl: GUESS });

            expect(found?.url).toBe(DEEZER_URL);
        });

        it("refuses a handed-out address that 404s, rather than sending it anyway", async () => {
            // An address that 404s is never sent on as a last resort.
            expect(await findAlbumArtwork({ ...ALBUM, candidateUrl: GUESS })).toBeNull();
        });

        it("takes a handed-out address that loads when nobody else has one", async () => {
            fetchSpy.mockImplementation((async () =>
                ({ ok: true, status: 200 }) as unknown as Response) as never);

            const found = await findAlbumArtwork({ ...ALBUM, candidateUrl: GUESS });

            expect(found).toEqual({ url: GUESS, source: "given" });
        });

        it("keeps a handed-out address when the check times out, because that is not an answer", async () => {
            fetchSpy.mockImplementation((async () => {
                throw new Error("The operation was aborted due to timeout");
            }) as never);

            const found = await findAlbumArtwork({ ...ALBUM, candidateUrl: GUESS });

            expect(found?.url).toBe(GUESS);
        });

        it("will not check a handed-out address the SSRF guard rejects", async () => {
            const found = await findAlbumArtwork({
                ...ALBUM,
                candidateUrl: "http://169.254.169.254/latest",
            });

            expect(found).toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("still asks Deezer when the id is one this app invented", async () => {
            // The scanner mints "temp-<...>" for any album it cannot match to
            // MusicBrainz -- 436 of 949 albums in a real library. The id-keyed
            // sources cannot use one, but Deezer never needed an id.
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            const found = await findAlbumArtwork({ ...ALBUM, rgMbid: "temp-123" });

            expect(deezerAlbum).toHaveBeenCalledWith("Brad Sucks", "I Don't Know What I'm Doing");
            expect(archiveCover).not.toHaveBeenCalled();
            expect(fanartAlbum).not.toHaveBeenCalled();
            expect(found?.url).toBe(DEEZER_URL);
        });

        it("does not let two unmatched albums share one remembered answer", async () => {
            // Keying the cache on a "temp-" id would do exactly that: those ids
            // are minted per scan, so they identify nothing.
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            await findAlbumArtwork({ rgMbid: "temp-1", artistName: "Soen", albumTitle: "Reliance" });
            await findAlbumArtwork({ rgMbid: "temp-1", artistName: "Klone", albumTitle: "Black Days" });

            expect(deezerAlbum).toHaveBeenCalledTimes(2);
            const keys = mockSetex.mock.calls.map((c) => c[0]);
            expect(new Set(keys).size).toBe(2);
        });

        it("asks nobody at all without an artist and a title", async () => {
            expect(await findAlbumArtwork({ artistName: "", albumTitle: "" })).toBeNull();
            expect(deezerAlbum).not.toHaveBeenCalled();
        });
    });

    describe("artist images", () => {
        it("keeps asking after the first source comes up empty", async () => {
            deezerArtist.mockResolvedValue(DEEZER_URL);

            const found = await findArtistArtwork(ARTIST);

            expect(fanartArtist).toHaveBeenCalledWith("9c070e4f-28c1-4b98-b371-d8514c31ba55", { interactive: undefined });
            expect(found).toEqual({ url: DEEZER_URL, source: "deezer" });
        });

        it("skips Fanart when the artist's id is one this app invented", async () => {
            deezerArtist.mockResolvedValue(DEEZER_URL);

            await findArtistArtwork({ name: "Brad Sucks", mbid: "temp-9" });

            expect(fanartArtist).not.toHaveBeenCalled();
            expect(deezerArtist).toHaveBeenCalled();
        });

        it("skips Fanart when there is no MBID to ask it about", async () => {
            deezerArtist.mockResolvedValue(DEEZER_URL);

            await findArtistArtwork({ name: "Brad Sucks" });

            expect(fanartArtist).not.toHaveBeenCalled();
        });

        it("returns nothing when every source has said no", async () => {
            expect(await findArtistArtwork(ARTIST)).toBeNull();
        });
    });

    describe("what counts as evidence of absence", () => {
        it("does not write down 'nobody has it' when a source never answered", async () => {
            // If the providers are down, every album looked up during the
            // outage would otherwise be recorded as having no artwork for a
            // whole day, on the strength of nothing.
            deezerAlbum.mockRejectedValue(new Error("Deezer is unreachable"));
            archiveCover.mockRejectedValue(new Error("archive timed out"));
            fanartAlbum.mockRejectedValue(new Error("fanart 503"));

            const found = await findAlbumArtwork(ALBUM);

            expect(found).toBeNull();
            expect(mockSetex).not.toHaveBeenCalled();
        });

        it("still writes it down when every source answered and none had it", async () => {
            const found = await findAlbumArtwork(ALBUM);

            expect(found).toBeNull();
            expect(mockSetex).toHaveBeenCalledWith(expect.any(String), expect.any(Number), "NONE");
        });

        it("remembers a picture even when another source failed on the way", async () => {
            // A find is a find. Only absence needs unanimity.
            deezerAlbum.mockRejectedValue(new Error("Deezer is unreachable"));
            archiveCover.mockResolvedValue(ARCHIVE_URL);

            const found = await findAlbumArtwork(ALBUM);

            expect(found?.url).toBe(ARCHIVE_URL);
            expect(mockSetex).toHaveBeenCalledWith(expect.any(String), expect.any(Number), ARCHIVE_URL);
        });

        it("applies the same rule to artists", async () => {
            fanartArtist.mockRejectedValue(new Error("fanart 503"));
            deezerArtist.mockRejectedValue(new Error("deezer down"));

            expect(await findArtistArtwork(ARTIST)).toBeNull();
            expect(mockSetex).not.toHaveBeenCalled();
        });
    });

    describe("asking once when several callers arrive together", () => {
        it("collapses simultaneous lookups of the same record into one", async () => {
            // The cache stops the second request, never the first N that arrive
            // at the same moment -- which is exactly what one page load is.
            // Held open until all three callers have arrived, which is what
            // makes them simultaneous rather than sequential.
            let release!: (v: string | null) => void;
            const gate = new Promise<string | null>((r) => {
                release = r;
            });
            deezerAlbum.mockImplementation(() => gate);

            const all = Promise.all([
                findAlbumArtwork(ALBUM),
                findAlbumArtwork(ALBUM),
                findAlbumArtwork(ALBUM),
            ]);
            await new Promise((r) => setTimeout(r, 20));
            release(DEEZER_URL);
            const results = await all;

            expect(deezerAlbum).toHaveBeenCalledTimes(1);
            expect(results.map((r) => r?.url)).toEqual([DEEZER_URL, DEEZER_URL, DEEZER_URL]);
        });

        it("does not collapse two different records", async () => {
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            await Promise.all([
                findAlbumArtwork({ artistName: "Soen", albumTitle: "Reliance" }),
                findAlbumArtwork({ artistName: "Klone", albumTitle: "Black Days" }),
            ]);

            expect(deezerAlbum).toHaveBeenCalledTimes(2);
        });

        it("lets the next caller try again after a lookup finishes", async () => {
            // A held-open entry would pin a stale answer for the process's life.
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            await findAlbumArtwork(ALBUM);
            await findAlbumArtwork(ALBUM);

            expect(deezerAlbum).toHaveBeenCalledTimes(2);
        });
    });

    describe("remembering", () => {
        it("does not ask any source once it knows the answer", async () => {
            mockGet.mockResolvedValue(DEEZER_URL);

            const found = await findAlbumArtwork(ALBUM);

            expect(found?.url).toBe(DEEZER_URL);
            expect(deezerAlbum).not.toHaveBeenCalled();
            expect(archiveCover).not.toHaveBeenCalled();
        });

        it("treats a remembered miss as a miss, without going out again", async () => {
            mockGet.mockResolvedValue("NONE");

            expect(await findAlbumArtwork(ALBUM)).toBeNull();
            expect(deezerAlbum).not.toHaveBeenCalled();
        });

        it("re-checks a miss far sooner than it re-checks a hit", async () => {
            await findAlbumArtwork(ALBUM);
            const [, missTtl, missValue] = mockSetex.mock.calls[0];

            jest.clearAllMocks();
            mockGet.mockResolvedValue(null);
            mockSetex.mockResolvedValue("OK");
            deezerAlbum.mockResolvedValue(DEEZER_URL);
            await findAlbumArtwork({ ...ALBUM, rgMbid: "d0484284-1ee7-4157-951a-50f003cbcfb4" });
            const [, hitTtl] = mockSetex.mock.calls[0];

            expect(missValue).toBe("NONE");
            expect(missTtl).toBeLessThan(hitTtl);
        });

        it("keeps albums and artists apart even under the same name", async () => {
            deezerAlbum.mockResolvedValue(DEEZER_URL);
            deezerArtist.mockResolvedValue(FANART_URL);

            const album = await findAlbumArtwork({
                artistName: "Klone",
                albumTitle: "Klone",
            });
            const artist = await findArtistArtwork({ name: "Klone" });

            expect(album?.url).toBe(DEEZER_URL);
            expect(artist?.url).toBe(FANART_URL);
        });

        it("keeps working when the cache is down", async () => {
            mockGet.mockRejectedValue(new Error("Redis is not available"));
            mockSetex.mockRejectedValue(new Error("Redis is not available"));
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            expect((await findAlbumArtwork(ALBUM))?.url).toBe(DEEZER_URL);
        });
    });

    describe("a page's worth at a time", () => {
        it("does the same for a list of artists", async () => {
            deezerArtist.mockResolvedValue(DEEZER_URL);

            const result = await withArtistArtwork(
                [{ name: "Brad Sucks", mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55" }, { name: "", mbid: null }],
                (a) => ({ name: a.name, mbid: a.mbid }),
                (a, image) => ({ ...a, image }),
            );

            expect(result).toEqual([
                { name: "Brad Sucks", mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55", image: DEEZER_URL },
                { name: "", mbid: null, image: null },
            ]);
        });

        it("puts the answer on the caller's own shape and leaves the rest alone", async () => {
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            const result = await withAlbumArtwork(
                [{ id: 7, title: "I Don't Know What I'm Doing", artist: "Brad Sucks", coverUrl: GUESS as string | null }],
                (i) => ({ rgMbid: "10e85e9b-0f07-33d4-a927-18a273f86eca", artistName: i.artist, albumTitle: i.title, candidateUrl: i.coverUrl }),
                (i, coverUrl) => ({ ...i, coverUrl }),
            );

            expect(result).toEqual([
                { id: 7, title: "I Don't Know What I'm Doing", artist: "Brad Sucks", coverUrl: DEEZER_URL },
            ]);
        });

        it("looks a record up once however many times it is listed", async () => {
            deezerAlbum.mockResolvedValue(DEEZER_URL);

            await withAlbumArtwork(
                [{ n: 1 }, { n: 2 }, { n: 3 }],
                () => ALBUM,
                (i, coverUrl) => ({ ...i, coverUrl }),
            );

            expect(deezerAlbum).toHaveBeenCalledTimes(1);
        });

        it("nulls an item it cannot even identify, rather than guessing", async () => {
            const result = await withAlbumArtwork(
                [{ title: "", artist: "", coverUrl: GUESS as string | null }],
                (i) => ({ artistName: i.artist, albumTitle: i.title, candidateUrl: i.coverUrl }),
                (i, coverUrl) => ({ ...i, coverUrl }),
            );

            expect(result[0].coverUrl).toBeNull();
            expect(deezerAlbum).not.toHaveBeenCalled();
        });

        it("does not make a page wait for lookups it cannot finish in time", async () => {
            deezerAlbum.mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve(null), 60)),
            );

            const started = performance.now();
            pastTheBudget();
            const result = await withAlbumArtwork(
                [{ coverUrl: GUESS as string | null }],
                () => ({ ...ALBUM, candidateUrl: GUESS }),
                (i, coverUrl) => ({ ...i, coverUrl }),
            );

            expect(performance.now() - started).toBeLessThan(40);
            expect(result[0].coverUrl).toBeNull();
            await outlivedLookup();
        });

        it("never falls back to the unchecked address when it runs out of time", async () => {
            // A slow load must not pass an unchecked candidate address through;
            // the placeholder is returned instead, though the address would load.
            deezerAlbum.mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve(null), 60)),
            );
            fetchSpy.mockImplementation((async () => ({ ok: true, status: 200 }) as unknown as Response) as never);
            pastTheBudget();

            const result = await withAlbumArtwork(
                [{ coverUrl: GUESS as string | null }],
                () => ({ ...ALBUM, candidateUrl: GUESS }),
                (i, coverUrl) => ({ ...i, coverUrl }),
            );

            expect(result[0].coverUrl).not.toBe(GUESS);
            expect(JSON.stringify(result)).not.toContain("front-500");
            await outlivedLookup();
        });

        it("does nothing at all for an empty list", async () => {
            const result = await withAlbumArtwork(
                [] as { coverUrl: string | null }[],
                () => ALBUM,
                (i, coverUrl) => ({ ...i, coverUrl }),
            );

            expect(result).toEqual([]);
            expect(mockGet).not.toHaveBeenCalled();
        });
    });
});
