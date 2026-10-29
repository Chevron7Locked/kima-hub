/**
 * The MusicBrainz lookups identification and import rely on: the ISRC's recordings and the name
 * searches keep only a recording that is the track; an artist's catalogue is read to its end, past
 * the first 100 release groups.
 */

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

const expected = { title: "Daydreaming", artists: ["Paramore"], durationSec: 271 };
const recording = (id: string, title: string, lengthMs: number, artist: string, score?: number) => ({
    id, title, length: lengthMs, score, "artist-credit": [{ name: artist, artist: { name: artist }, joinphrase: "" }],
});

beforeEach(() => {
    jest.clearAllMocks();
    redisStore = {};
});

describe("the ISRC's recordings", () => {
    it("never sends a code that is not an ISRC", async () => {
        const out = await musicBrainzService.lookupRecordingsByIsrc("PMEDIA");
        expect(out.kind).toBe("absent");
        expect(mockGet).not.toHaveBeenCalled();
    });

    it("treats a code MusicBrainz refuses as no answer, not a failure", async () => {
        mockGet.mockRejectedValue(Object.assign(new Error("400"), { response: { status: 400 } }));
        expect((await musicBrainzService.lookupRecordingsByIsrc("USRC17607839")).kind).toBe("absent");
    });

    it("returns every recording with its length and credits", async () => {
        mockGet.mockResolvedValue({ data: { recordings: [recording("a", "Decode", 262000, "Paramore"), recording("b", "Daydreaming", 271400, "Paramore")] } });
        const out = await musicBrainzService.lookupRecordingsByIsrc("us-rc1-76-07839");
        expect(mockGet).toHaveBeenCalledWith("/isrc/USRC17607839", expect.objectContaining({ params: { fmt: "json", inc: "artist-credits" } }));
        expect(out.kind === "answered" && out.value.map((c) => [c.id, c.lengthMs])).toEqual([["a", 262000], ["b", 271400]]);
    });
});

describe("the name search", () => {
    it("takes the candidate that is the track, not the top hit", async () => {
        mockGet.mockResolvedValue({
            data: { recordings: [recording("live", "Daydreaming (Live)", 271000, "Paramore", 100), recording("studio", "Daydreaming", 270600, "Paramore", 90)] },
        });
        const out = await musicBrainzService.identifyRecording(expected);
        expect(out.kind === "answered" && out.value.id).toBe("studio");
    });

    it("answers absent when no candidate is the track", async () => {
        mockGet.mockResolvedValue({ data: { recordings: [recording("x", "Daydreaming", 271000, "Radiohead", 100)] } });
        expect((await musicBrainzService.identifyRecording(expected)).kind).toBe("absent");
    });

    it("treats a query MusicBrainz refuses as no answer, so the next source is asked", async () => {
        mockGet.mockRejectedValue(Object.assign(new Error("400"), { response: { status: 400 } }));
        expect((await musicBrainzService.identifyRecording(expected)).kind).toBe("absent");
        expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it("asks nothing for a title with nothing left to search by (a title all in brackets)", async () => {
        expect((await musicBrainzService.identifyRecording({ ...expected, title: "(untitled)" })).kind).toBe("absent");
        expect(mockGet).not.toHaveBeenCalled();
    });
});

describe("the album a track is on, by name search", () => {
    const onAlbum = (rec: object, albumTitle: string, rgId: string) => ({
        ...rec,
        releases: [{ status: "Official", "release-group": { id: rgId, title: albumTitle, "primary-type": "Album" } }],
    });

    it("skips a top hit that is another artist's song or another version's length", async () => {
        mockGet.mockResolvedValue({
            data: {
                recordings: [
                    onAlbum(recording("cover", "Daydreaming", 271000, "Radiohead", 100), "A Moon Shaped Pool", "rg-cover"),
                    onAlbum(recording("edit", "Daydreaming", 200000, "Paramore", 95), "Edits", "rg-edit"),
                    onAlbum(recording("ours", "Daydreaming", 270600, "Paramore", 90), "Brand New Eyes", "rg-ours"),
                ],
            },
        });
        const out = await musicBrainzService.searchRecording(expected);
        expect(out.kind === "answered" && out.value).toMatchObject({ albumMbid: "rg-ours", trackMbid: "ours" });
    });

    it("passes over a recording MusicBrainz marks live", async () => {
        mockGet.mockResolvedValue({
            data: {
                recordings: [
                    onAlbum({ ...recording("live", "Daydreaming", 271000, "Paramore", 100), disambiguation: "live, 2010-06-12" }, "Live", "rg-live"),
                ],
            },
        });
        expect((await musicBrainzService.searchRecording(expected)).kind).toBe("absent");
    });
});

describe("an artist's whole catalogue", () => {
    it("pages past the first 100 release groups", async () => {
        const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `rg${from + i}`, title: `Album ${from + i}` }));
        mockGet
            .mockResolvedValueOnce({ data: { "release-group-count": 230, "release-groups": page(0, 100) } })
            .mockResolvedValueOnce({ data: { "release-group-count": 230, "release-groups": page(100, 100) } })
            .mockResolvedValueOnce({ data: { "release-group-count": 230, "release-groups": page(200, 30) } });
        const out = await musicBrainzService.getAllReleaseGroups("artist-1", ["album"]);
        expect(out.kind === "answered" && out.value.length).toBe(230);
        expect(mockGet.mock.calls.map((c) => c[1].params.offset)).toEqual([0, 100, 200]);
    });
});

describe("a recording's ISRC and genres", () => {
    it("come from one request, and the genre lookup then finds its answer cached", async () => {
        mockGet.mockResolvedValueOnce({
            data: {
                isrcs: ["USAT21000001", "USAT21000002"],
                genres: [{ name: "pop punk", count: 3 }, { name: "voted down", count: 0 }],
                tags: [{ name: "pop punk", count: 3 }],
            },
        });

        const both = await musicBrainzService.getRecordingIsrcAndGenres("rec-1");

        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(mockGet.mock.calls[0][1].params.inc).toBe("isrcs+genres+tags");
        expect(both.isrc).toMatchObject({ kind: "answered", value: "USAT21000001" });
        expect(both.genres).toMatchObject({ kind: "answered", value: { genres: [{ name: "pop punk", count: 3 }] } });
        expect(await musicBrainzService.getRecordingGenres("rec-1")).toMatchObject({
            kind: "answered",
            value: { genres: [{ name: "pop punk", count: 3 }] },
        });
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("the genre lookup asks once and caches both answers", async () => {
        mockGet.mockResolvedValueOnce({ data: { isrcs: ["GBAYE0601498"], genres: [{ name: "rock", count: 1 }], tags: [] } });
        expect((await musicBrainzService.getRecordingGenres("rec-2")).kind).toBe("answered");
        mockGet.mockClear();

        const both = await musicBrainzService.getRecordingIsrcAndGenres("rec-2");

        expect(mockGet).not.toHaveBeenCalled();
        expect(both.isrc).toMatchObject({ kind: "answered", value: "GBAYE0601498" });
    });
});

describe("a name search that fails", () => {
    const failing = (status?: number) =>
        Object.assign(new Error(status ? String(status) : "socket hang up"), status ? { response: { status } } : { code: "ECONNRESET" });

    it("stops at a rate limit without asking the second query", async () => {
        mockGet.mockRejectedValue(failing(503));
        mockHandleRateLimit.mockResolvedValueOnce(true);
        expect((await musicBrainzService.identifyRecording(expected)).kind).toBe("rateLimited");
        expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it("answers with the failure, not 'nothing found', when no query answered", async () => {
        mockGet.mockRejectedValueOnce(failing()).mockResolvedValueOnce({ data: { recordings: [] } });
        expect((await musicBrainzService.identifyRecording(expected)).kind).toBe("transient");
        expect(mockGet).toHaveBeenCalledTimes(2);
    });

    it("a later query that finds the track wins over an earlier failure", async () => {
        mockGet
            .mockRejectedValueOnce(failing())
            .mockResolvedValueOnce({ data: { recordings: [recording("studio", "Daydreaming", 270600, "Paramore", 90)] } });
        const out = await musicBrainzService.identifyRecording(expected);
        expect(out.kind === "answered" && out.value.id).toBe("studio");
    });

    it("reads a 404 as nothing found when identifying a song, and as a failure when finding its album", async () => {
        mockGet.mockRejectedValue(failing(404));
        expect((await musicBrainzService.identifyRecording(expected)).kind).toBe("absent");
        redisStore = {};
        expect((await musicBrainzService.searchRecording(expected)).kind).toBe("permanent");
    });
});

it("asks for releases only when finding a song's album", async () => {
    mockGet.mockResolvedValue({ data: { recordings: [] } });
    await musicBrainzService.identifyRecording(expected);
    await musicBrainzService.searchRecording(expected);
    const params = mockGet.mock.calls.map((c) => (c[1] as { params: Record<string, unknown> }).params);
    expect(params.slice(0, 2).every((p) => !("inc" in p))).toBe(true);
    expect(params.slice(2).map((p) => p.inc)).toEqual(["releases+release-groups+artists", "releases+release-groups+artists"]);
});
