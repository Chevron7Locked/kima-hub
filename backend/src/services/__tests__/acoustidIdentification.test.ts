/**
 * identifyTrackByAcoustid opens the file through the music folder (filePath is
 * stored relative to it), and never treats an `acoustid_id` tag as a
 * MusicBrainz recording id. Refusals and lookup failures are typed Outcomes.
 */

jest.mock("../../config", () => ({ config: { music: { musicPath: "/srv/music" } } }));
jest.mock("../../utils/db", () => ({ prisma: { track: { update: jest.fn() } } }));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock("../../utils/metrics", () => ({ acoustidTrackIdentityTotal: { inc: jest.fn() } }));

const mockParseFile = jest.fn();
jest.mock("music-metadata", () => ({ parseFile: (...a: unknown[]) => mockParseFile(...a) }));

const mockFingerprintFile = jest.fn();
jest.mock("../fpcalc", () => ({
    fpcalcService: {
        isAvailable: jest.fn().mockResolvedValue(true),
        fingerprintFile: (...a: unknown[]) => mockFingerprintFile(...a),
    },
}));

const mockLookup = jest.fn();
const mockLookupMany = jest.fn().mockResolvedValue(0);
const mockHasSavedReply = jest.fn().mockResolvedValue(false);
const mockMayAskInBatches = jest.fn().mockResolvedValue(true);
jest.mock("../acoustidService", () => ({
    acoustidService: {
        lookup: (...a: unknown[]) => mockLookup(...a),
        lookupMany: (...a: unknown[]) => mockLookupMany(...a),
        hasSavedReply: (...a: unknown[]) => mockHasSavedReply(...a),
        mayAskInBatches: (...a: unknown[]) => mockMayAskInBatches(...a),
    },
}));

import { identifyTrackByAcoustid, prefetchAcoustidReplies } from "../acoustidIdentification";
import { answered } from "../../utils/outcome";

const RECORDING = "8f3471b5-7e6a-48da-86a9-c1c07a0f47ae";
const ACOUSTID_TRACK = "9ff43b6a-4f16-427c-93c2-92307ca505e0";

const FILE_MODIFIED = new Date("2026-10-01T00:00:00Z");
const track = (filePath: string) => ({ id: "t1", title: "Song", filePath, duration: 200, fileModified: FILE_MODIFIED });
const tags = (common: Record<string, unknown>) => ({ common, format: { duration: 200 } });

beforeEach(() => {
    jest.clearAllMocks();
    mockParseFile.mockResolvedValue(tags({}));
    mockFingerprintFile.mockResolvedValue({ duration: 200, fingerprint: "FP" });
    mockLookup.mockResolvedValue(
        answered(
            {
                recordingMbid: RECORDING,
                artistMbid: "",
                releaseGroups: [],
                candidates: [RECORDING],
                title: "Song",
                artist: "",
            },
            { score: 0.9 },
        ),
    );
});

describe("identifyTrackByAcoustid: the file it opens", () => {
    it("with no fingerprint anywhere, the step refuses — fpcalc is never run, never a fake answer", async () => {
        // With no fingerprint anywhere the step refuses (permanent
        // NO_FINGERPRINT): no lookup and no second decode of the file.
        const out = await identifyTrackByAcoustid(
            track("Artist/Album/01 Song.flac"),
        );

        expect(mockParseFile).toHaveBeenCalledWith("/srv/music/Artist/Album/01 Song.flac");
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();
        expect(out.kind).toBe("permanent");
        if (out.kind === "permanent") {
            expect(out.error.code).toBe("NO_FINGERPRINT");
        }
    });

    it("refuses a stored path that would escape the music folder", async () => {
        const out = await identifyTrackByAcoustid(track("../../etc/passwd"));

        expect(out.kind).toBe("permanent");
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();
    });
});

describe("identifyTrackByAcoustid: what it trusts from tags", () => {
    it("never returns an acoustid_id tag as the recording id", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_id: ACOUSTID_TRACK }));

        const out = await identifyTrackByAcoustid(track("a.flac"));

        // The tag names a fingerprint cluster, not a recording — and with no
        // fingerprint to ask with the step refuses rather than run fpcalc.
        expect(out.kind).toBe("permanent");
        if (out.kind === "permanent") {
            expect(out.error.code).toBe("NO_FINGERPRINT");
        }
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();
    });

    it("takes a musicbrainz_recordingid tag as the recording, with no network call", async () => {
        const tagged = "0b3d3c4e-1111-2222-3333-444455556666";
        mockParseFile.mockResolvedValue(tags({ musicbrainz_recordingid: tagged }));

        const out = await identifyTrackByAcoustid(track("a.flac"));

        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "file_tag", recordingMbid: tagged }),
            );
        }
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();
    });

    it("looks up a stored acoustid_fingerprint tag instead of running fpcalc", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_fingerprint: "TAGFP" }));

        const out = await identifyTrackByAcoustid(track("a.flac"));

        expect(mockLookup).toHaveBeenCalledWith(200, "TAGFP", { title: "Song" });
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "acoustid", fingerprintFrom: "file tag", fingerprint: "TAGFP" }),
            );
        }
    });
});

describe("identifyTrackByAcoustid: the stored fingerprint", () => {
    it("answers from Track.acoustidFingerprint and never calls fpcalc", async () => {
        mockParseFile.mockResolvedValue(tags({}));

        const out = await identifyTrackByAcoustid(track("a.flac"), null, {
            fingerprint: "STOREDFP",
        });

        // One lookup with the fingerprint the stage already measured.
        expect(mockLookup).toHaveBeenCalledWith(200, "STOREDFP", { title: "Song" });
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(
                expect.objectContaining({ source: "acoustid", fingerprintFrom: "stored", fingerprint: "STOREDFP" }),
            );
        }
    });

    it("answers from the stored fingerprint even when the tags are unreadable", async () => {
        mockParseFile.mockRejectedValue(new Error("unreadable"));

        const out = await identifyTrackByAcoustid(track("a.flac"), null, {
            fingerprint: "STOREDFP",
        });

        expect(mockLookup).toHaveBeenCalledWith(200, "STOREDFP", { title: "Song" });
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(out.kind).toBe("answered");
        if (out.kind === "answered") {
            expect(out.value).toEqual(expect.objectContaining({ source: "acoustid", fingerprintFrom: "stored" }));
        }
    });

    it("passes a lookup failure through as the same kind — the question stays open", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_fingerprint: "TAGFP" }));
        mockLookup.mockResolvedValue({
            kind: "transient",
            error: { code: "REQUEST_FAILED", message: "ECONNREFUSED" },
        });

        const out = await identifyTrackByAcoustid(track("a.flac"));

        expect(out.kind).toBe("transient");
        if (out.kind === "transient") {
            expect(out.error.message).toBe("ECONNREFUSED");
        }
    });
});

describe("prefetchAcoustidReplies: what the batch asks about", () => {
    it("asks with the file's fingerprint tag, else the stored fingerprint, and skips files that name their recording", async () => {
        mockParseFile.mockImplementation(async (file: string) =>
            file.endsWith("tagged.flac")
                ? tags({ musicbrainz_recordingid: RECORDING })
                : file.endsWith("own-fp.flac")
                  ? tags({ acoustid_fingerprint: "TAG-FP" })
                  : tags({}),
        );

        await prefetchAcoustidReplies([
            { ...track("a/tagged.flac"), id: "a-tagged", acoustidFingerprint: "STORED-1" },
            { ...track("a/own-fp.flac"), id: "a-own-fp", acoustidFingerprint: "STORED-2" },
            { ...track("a/plain.flac"), id: "a-plain", acoustidFingerprint: "STORED-3" },
            { ...track("a/none.flac"), id: "a-none", acoustidFingerprint: null },
        ]);

        expect(mockLookupMany).toHaveBeenCalledTimes(1);
        expect(mockLookupMany).toHaveBeenCalledWith([
            { trackId: "a-own-fp", duration: 200, fingerprint: "TAG-FP" },
            { trackId: "a-plain", duration: 200, fingerprint: "STORED-3" },
        ]);
    });

    it("never reads the file of a song already answered, or of one whose tags named its recording before", async () => {
        mockHasSavedReply.mockImplementation(async (_d: number, fp: string) => fp === "STORED-SAVED");
        mockParseFile.mockImplementation(async (file: string) =>
            file.endsWith("named.flac") ? tags({ musicbrainz_recordingid: RECORDING }) : tags({}),
        );
        const named = { ...track("b/named.flac"), id: "named", acoustidFingerprint: "STORED-N" };

        await prefetchAcoustidReplies([{ ...track("b/saved.flac"), id: "saved", acoustidFingerprint: "STORED-SAVED" }, named]);
        await prefetchAcoustidReplies([named]);

        const opened = mockParseFile.mock.calls.map(([file]) => String(file));
        expect(opened.filter((f) => f.endsWith("saved.flac"))).toHaveLength(0);
        expect(opened.filter((f) => f.endsWith("named.flac"))).toHaveLength(1);
        expect(mockLookupMany).not.toHaveBeenCalled();
    });

    it("never asks again once a batch saved its reply, even under a fingerprint other than the stored one", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_fingerprint: "TAG-FP-D" }));
        mockHasSavedReply.mockImplementation(async (_d: number, fp: string) => fp === "TAG-FP-D" && mockLookupMany.mock.calls.length > 0);
        mockLookupMany.mockResolvedValue(1);
        const song = { ...track("d/own-tag.flac"), id: "d-own-tag", acoustidFingerprint: "STORED-D" };

        await prefetchAcoustidReplies([song]);
        await prefetchAcoustidReplies([song]);

        expect(mockLookupMany).toHaveBeenCalledTimes(1);
    });

    it("reads a file again once it changed: a recording tag removed since means it is asked about", async () => {
        mockParseFile.mockResolvedValue(tags({ musicbrainz_recordingid: RECORDING }));
        const song = { ...track("e/retagged.flac"), id: "e-retagged", acoustidFingerprint: "STORED-E" };
        await prefetchAcoustidReplies([song]);
        await prefetchAcoustidReplies([song]);
        expect(mockParseFile).toHaveBeenCalledTimes(1);
        expect(mockLookupMany).not.toHaveBeenCalled();

        mockParseFile.mockResolvedValue(tags({}));
        await prefetchAcoustidReplies([{ ...song, fileModified: new Date("2026-10-02T00:00:00Z") }]);

        expect(mockParseFile).toHaveBeenCalledTimes(2);
        expect(mockLookupMany).toHaveBeenCalledWith([{ trackId: "e-retagged", duration: 200, fingerprint: "STORED-E" }]);
    });

    it("asks again once a batch's saved reply has expired", async () => {
        mockParseFile.mockResolvedValue(tags({ acoustid_fingerprint: "TAG-FP-F" }));
        mockLookupMany.mockResolvedValue(1);
        const song = { ...track("f/expired.flac"), id: "f-expired", acoustidFingerprint: null };

        await prefetchAcoustidReplies([song]);
        // The saved reply's lifetime ran out: nothing is saved under the fingerprint any more.
        mockHasSavedReply.mockResolvedValue(false);
        await prefetchAcoustidReplies([song]);

        expect(mockLookupMany).toHaveBeenCalledTimes(2);
        expect(mockLookupMany).toHaveBeenLastCalledWith([{ trackId: "f-expired", duration: 200, fingerprint: "TAG-FP-F" }]);
    });

    it("reads no file at all while AcoustID cannot be asked in batches (paused, no key, a batch just failed)", async () => {
        mockMayAskInBatches.mockResolvedValueOnce(false);

        expect(await prefetchAcoustidReplies([{ ...track("c/any.flac"), id: "c-any", acoustidFingerprint: "STORED-C" }])).toBe(0);
        expect(mockParseFile).not.toHaveBeenCalled();
        expect(mockLookupMany).not.toHaveBeenCalled();
    });

    it("asks nothing when no song has a fingerprint to ask with", async () => {
        expect(await prefetchAcoustidReplies([{ ...track("a/none.flac"), acoustidFingerprint: null }])).toBe(0);
        expect(mockLookupMany).not.toHaveBeenCalled();
    });
});
