/**
 * getAlbumCatalogue against verbatim MusicBrainz responses for Daft Punk
 * "Discovery" (fixtures/mb/): the release group and its earliest release.
 */

const rgFixture = require("./fixtures/mb/rg-discovery.json");
const releaseFixture = require("./fixtures/mb/release-discovery-early.json");

const RG_MBID = "48117b90-a16e-34ca-a514-19c702df1158";
const EARLIEST_RELEASE = "bd3bb36e-16c8-438f-850e-dfbf4d1478f0";

const mockGet = jest.fn();
jest.mock("axios", () => ({
    create: () => ({ get: (...args: unknown[]) => mockGet(...args) }),
}));

let redisStore: Record<string, string>;
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: async (key: string) => redisStore[key] ?? null,
        set: async (key: string, value: string) => {
            redisStore[key] = value;
            return "OK";
        },
        setex: async (key: string, _ttl: number, value: string) => {
            redisStore[key] = value;
            return "OK";
        },
    },
}));

jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: {
        execute: async (_source: string, fn: () => Promise<unknown>) =>
            fn(),
    },
}));

const mockHandleRateLimit = jest.fn().mockResolvedValue(false);
jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: {
        handleRateLimit: (...args: unknown[]) =>
            mockHandleRateLimit(...args),
        getPause: jest.fn().mockResolvedValue(null),
    },
}));

jest.mock("../../config", () => ({
    USER_AGENT: "KimaTest/1.0 (test@kima.local)",
    config: { musicbrainzBaseUrl: "https://musicbrainz.org/ws/2" },
}));

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { musicBrainzService } from "../musicbrainz";

beforeEach(() => {
    jest.clearAllMocks();
    redisStore = {};
    mockGet.mockImplementation(async (url: string) => {
        if (url === `/release-group/${RG_MBID}`) {
            return { data: rgFixture };
        }
        if (url === `/release/${EARLIEST_RELEASE}`) {
            return { data: releaseFixture };
        }
        throw new Error(`unexpected url ${url}`);
    });
});

describe("getAlbumCatalogue on real MusicBrainz responses", () => {
    it("names the release group MusicBrainz answered with: a merged-away id answers with the survivor's", async () => {
        const SURVIVOR = "11111111-2222-3333-4444-555555555555";
        mockGet.mockImplementation(async (url: string) => {
            if (url === `/release-group/${RG_MBID}`) return { data: { ...rgFixture, id: SURVIVOR } };
            if (url === `/release/${EARLIEST_RELEASE}`) return { data: releaseFixture };
            throw new Error(`unexpected url ${url}`);
        });

        const out = await musicBrainzService.getAlbumCatalogue(RG_MBID);

        expect(out.kind).toBe("answered");
        if (out.kind !== "answered") return;
        expect(out.value.releaseGroupMbid).toBe(SURVIVOR);
    });

    it("names the release group's own id when it was not merged", async () => {
        const out = await musicBrainzService.getAlbumCatalogue(RG_MBID);

        if (out.kind !== "answered") throw new Error("expected an answer");
        expect(out.value.releaseGroupMbid).toBe(RG_MBID);
    });

    it("two songs of one album asked at once share one fetch of its tracklist", async () => {
        const [first, second] = await Promise.all([
            musicBrainzService.getAlbumCatalogue(RG_MBID),
            musicBrainzService.getAlbumCatalogue(RG_MBID),
        ]);

        expect(first).toEqual(second);
        // One release-group request and one release request, not two of each.
        expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it("extracts the earliest release, its year, label, genres, and the full tracklist", async () => {
        const out = await musicBrainzService.getAlbumCatalogue(RG_MBID);

        expect(out.kind).toBe("answered");
        if (out.kind !== "answered") return;

        // The chain picked the chronologically first release of the group.
        expect(out.value.releaseMbid).toBe(EARLIEST_RELEASE);
        expect(out.value.originalYear).toBe(2001);
        expect(out.value.label).toBe("Parlophone");

        // The album's genres are the release group's curated genres, with their votes.
        expect(out.value.genres).toContainEqual({ name: "dance", count: 3 });
        expect(out.value.genres.every((g) => g.count > 0)).toBe(true);

        // The tracklist is the release's real one: 14 tracks, the first row with its recording id, position,
        // length, ISRCs, curated genres and credit.
        expect(out.value.recordings).toHaveLength(14);
        const oneMoreTime = out.value.recordings[0];
        expect(oneMoreTime).toMatchObject({
            recordingId: "60fa767a-d85d-4991-82bc-4294e0b11ae7",
            title: "One More Time",
            position: 1,
            durationMs: 320746,
        });
        expect(oneMoreTime.isrcs).toContain("GBDUW0000053");
        expect(oneMoreTime.genres).toContainEqual({ name: "dance", count: 4 });
        expect(oneMoreTime.artists).toEqual(["Daft Punk"]);
    });

    it("keeps every name a track is credited to (the credit as written, the artist and its sort name)", async () => {
        const credited = JSON.parse(JSON.stringify(releaseFixture));
        credited.media[0].tracks[0]["artist-credit"] = [
            { name: "Daft Punk", joinphrase: " feat. ", artist: { name: "Daft Punk", "sort-name": "Daft Punk" } },
            { name: "Romanthony", joinphrase: "", artist: { name: "Romanthony", "sort-name": "Romanthony" } },
        ];
        mockGet.mockImplementation(async (url: string) =>
            url.startsWith("/release-group/") ? { data: rgFixture } : { data: credited },
        );

        const out = await musicBrainzService.getAlbumCatalogue(RG_MBID);

        if (out.kind !== "answered") throw new Error(`expected answered, got ${out.kind}`);
        expect(out.value.recordings[0].artists).toEqual(["Daft Punk", "Romanthony", "Daft Punk feat. Romanthony"]);
    });

    it("asks the two requests with exactly the increments the contract needs", async () => {
        await musicBrainzService.getAlbumCatalogue(RG_MBID);

        expect(mockGet).toHaveBeenCalledTimes(2);
        expect(mockGet).toHaveBeenNthCalledWith(1, `/release-group/${RG_MBID}`, {
            params: { inc: "releases+genres", fmt: "json" },
        });
        // ISRCs, genres and credits per track come only with `recordings`.
        expect(mockGet).toHaveBeenNthCalledWith(2, `/release/${EARLIEST_RELEASE}`, {
            params: { inc: "recordings+isrcs+labels+genres+artist-credits", fmt: "json" },
        });
    });

    it("picks the earliest official release whatever order MusicBrainz lists them in", async () => {
        const shuffled = { ...rgFixture, releases: [...rgFixture.releases].reverse() };
        mockGet.mockImplementation(async (url: string) =>
            url.startsWith("/release-group/") ? { data: shuffled } : { data: releaseFixture },
        );

        await musicBrainzService.getAlbumCatalogue(RG_MBID);

        expect(mockGet).toHaveBeenNthCalledWith(2, `/release/${EARLIEST_RELEASE}`, expect.anything());
    });

    it("answers `absent` for a made-up release-group id (real 404 → Not Found)", async () => {
        mockGet.mockImplementation(async () => {
            const err: any = new Error("Request failed with status code 404");
            err.response = { status: 404, data: { error: "Not Found" } };
            throw err;
        });

        const out = await musicBrainzService.getAlbumCatalogue(
            "00000000-0000-0000-0000-000000000000",
        );

        // A 404 is "the source has nothing", not a failure — the ladder
        // falls through to the per-track search.
        expect(out.kind).toBe("absent");
    });

    it("serves a second call for the same album from cache without HTTP", async () => {
        const first = await musicBrainzService.getAlbumCatalogue(RG_MBID);
        expect(first.kind).toBe("answered");

        const second = await musicBrainzService.getAlbumCatalogue(RG_MBID);

        // Same answer straight from the cache envelope — the whole album
        // pays the two requests once, not once per track.
        expect(second.kind).toBe("answered");
        if (first.kind === "answered" && second.kind === "answered") {
            expect(second.value).toEqual(first.value);
        }
        expect(mockGet).toHaveBeenCalledTimes(2);
    });
});