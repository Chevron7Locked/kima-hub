/**
 * identifyTrack identifies a recording in this order: the file's recording id tag, AcoustID by the sound, the album's
 * MusicBrainz tracklist (the album row's own, else the one AcoustID lists), the ISRC, then the name search; the
 * fingerprint is stored even on a no-match, and every MusicBrainz candidate must agree it is this track.
 * The identification services are mocked; the song, its album and the stage record are real rows.
 */

// ── Mocks ───────────────────────────────────────────────────────────

const noData = { kind: "absent", evidence: { mocked: true } } as const;
const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

const mockGetFeatures = jest.fn().mockResolvedValue({ fpcalc: true });
jest.mock("../../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: () => mockGetFeatures(),
    },
}));

const mockReadTags = jest.fn();
const mockIdentifyTrackByAcoustid = jest.fn();
const mockPersistAcoustidFingerprint = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../services/acoustidIdentification", () => ({
    prefetchAcoustidReplies: jest.fn().mockResolvedValue(0),
    readIdentityTags: (...args: unknown[]) => mockReadTags(...args),
    identifyTrackByAcoustid: (...args: unknown[]) =>
        mockIdentifyTrackByAcoustid(...args),
    persistAcoustidFingerprint: (...args: unknown[]) =>
        mockPersistAcoustidFingerprint(...args),
}));

const mockIdentifyRecording = jest.fn();
const mockGetRecordingIsrc = jest.fn();
const mockGetRecordingGenres = jest.fn();
const mockLookupRecordingsByIsrc = jest.fn();
const mockGetAlbumCatalogue = jest.fn();
jest.mock("../../../services/musicbrainz", () => ({
    musicBrainzService: {
        identifyRecording: (...args: unknown[]) => mockIdentifyRecording(...args),
        getRecordingGenres: (...args: unknown[]) => mockGetRecordingGenres(...args),
        // The real one makes one request for both; here it answers from the two mocks.
        getRecordingIsrcAndGenres: async (id: string) => ({
            isrc: await mockGetRecordingIsrc(id),
            genres: await mockGetRecordingGenres(id),
        }),
        lookupRecordingsByIsrc: (...args: unknown[]) => mockLookupRecordingsByIsrc(...args),
        getAlbumCatalogue: (...args: unknown[]) => mockGetAlbumCatalogue(...args),
        normalizeForSearch: (s: string) => s,
    },
}));

const mockPopulateTrackGenres = jest.fn().mockResolvedValue(undefined);
jest.mock("../../../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: (...args: unknown[]) => mockPopulateTrackGenres(...args),
    },
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// ── Imports (after mocks) ───────────────────────────────────────────

import { identifyTrack } from "../identification";
import * as stageRecords from "../../../services/stages/stageRecords";
import { TimeoutError } from "../../../utils/timeout";
import { acoustidService } from "../../../services/acoustidService";
import { sourcePauseController } from "../../../services/sourcePauseController";
import { prisma } from "../../../utils/db";
import { putStage, deleteSeededRows } from "../../../__tests__/helpers/trackStage";

const P = "zz-aco";
const TRACK_ID = `${P}_t1`;
const ALBUM_ID = `${P}_alb`;
const RECORDING = "rec-aaaa-bbbb";
const MB_TRACK = "mb-track-1";
const FINGERPRINT = "AQAA0pMiRZkQ";
// Daft Punk "Discovery" — real ids verified against the API; nothing here
// hits the network, the service is mocked.
const RG_MBID = "48117b90-a16e-34ca-a514-19c702df1158";
const REL_MBID = "d073287b-d1bd-4f11-a933-a4386f8cf701";

interface SongSpec {
    title: string;
    artist: string;
    albumTitle: string;
    filePath: string;
    duration: number;
    isrc?: string | null;
    isrcSource?: string | null;
    fingerprint?: string | null;
    rgMbid: string;
    rgMbidSource?: string | null;
}

/** One library song on its own album and artist, replacing whatever an earlier seed left. */
async function seedSong(spec: SongSpec) {
    await wipe();
    await prisma.artist.create({ data: { id: `${P}_art`, name: spec.artist, identityKey: `${P}_a` } });
    await prisma.album.create({
        data: {
            id: ALBUM_ID,
            rgMbid: spec.rgMbid,
            rgMbidSource: spec.rgMbidSource ?? null,
            artistId: `${P}_art`,
            title: spec.albumTitle,
            primaryType: "Album",
        },
    });
    await prisma.track.create({
        data: {
            id: TRACK_ID,
            albumId: ALBUM_ID,
            title: spec.title,
            trackNo: 1,
            filePath: spec.filePath,
            duration: spec.duration,
            fileModified: new Date(),
            fileSize: 1000,
            isrc: spec.isrc ?? null,
            isrcSource: spec.isrcSource ?? null,
            acoustidFingerprint: spec.fingerprint ?? null,
        },
    });
}

async function seedTrack(
    overrides?: { isrc?: string | null; isrcSource?: string | null; rgMbid?: string | null },
) {
    await seedSong({
        title: "Cheerleader Effect",
        artist: "Carpenter Brut",
        albumTitle: "Leather Teeth",
        filePath: `/music/${P}/02 - Cheerleader Effect.mp3`,
        duration: 218,
        isrc: overrides?.isrc ?? null,
        isrcSource: overrides?.isrcSource ?? (overrides?.isrc ? "id3" : null),
        // A placeholder id is locally made up: with it the chain step is skipped and the per-track ladder runs.
        rgMbid: overrides?.rgMbid ?? "temp-1693-abc",
    });
}

const wipe = () => deleteSeededRows(P);
const trackRow = () => prisma.track.findUniqueOrThrow({ where: { id: TRACK_ID } });
const albumRow = () => prisma.album.findUniqueOrThrow({ where: { id: ALBUM_ID } });
const recordingStage = () =>
    prisma.trackStage.findUnique({ where: { trackId_stage: { trackId: TRACK_ID, stage: "recording" } } });

/** True when the song's recording question holds a `done` answer given by `source`. */
async function stageWrittenDone(source: string): Promise<boolean> {
    const stage = await recordingStage();
    return stage?.status === "done" && stage.source === source;
}

beforeAll(wipe);
afterAll(wipe);

beforeEach(async () => {
    jest.clearAllMocks();
    mockGetFeatures.mockResolvedValue({ fpcalc: true });
    mockReadTags.mockResolvedValue({
        recordingMbid: null,
        fingerprint: null,
        artists: [],
        duration: 218,
    });
    mockIdentifyTrackByAcoustid.mockResolvedValue({
        kind: "absent",
        evidence: { reason: "mocked: nothing to match" },
    });
    mockIdentifyRecording.mockResolvedValue(noData);
    mockGetRecordingIsrc.mockResolvedValue(noData);
    mockGetRecordingGenres.mockResolvedValue(noData);
    mockLookupRecordingsByIsrc.mockResolvedValue(noData);
    await seedTrack();
});

describe("identifyTrack: the identification order", () => {
    it("answers from the file's recording-id tag without any network call", async () => {
        mockReadTags.mockResolvedValue({
            recordingMbid: RECORDING,
            fingerprint: FINGERPRINT,
            duration: 218,
        });

        await identifyTrack(TRACK_ID);

        expect(mockReadTags).toHaveBeenCalledWith(
            expect.objectContaining({ id: TRACK_ID, filePath: expect.any(String) }),
        );
        // Tags answered — neither the search nor the fingerprint path runs.
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        // The tag's fingerprint is stored too (dedupe value, zero cost).
        expect(mockPersistAcoustidFingerprint).toHaveBeenCalledWith(
            TRACK_ID,
            FINGERPRINT,
        );
        // The answer lands on Track and on the stage record.
        expect((await trackRow()).recordingMbid).toBe(RECORDING);
        expect(await stageWrittenDone("file_tag")).toBe(true);
    });

    it("asks AcoustID before the name search, which gets the track's title, artist and length", async () => {
        await identifyTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalledWith({
            title: "Cheerleader Effect",
            artists: ["Carpenter Brut"],
            durationSec: 218,
        });
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid.mock.invocationCallOrder[0]).toBeLessThan(
            mockIdentifyRecording.mock.invocationCallOrder[0],
        );
    });

    it("never runs the name search for a track AcoustID answered", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: MB_TRACK, releaseGroups: [], candidates: [MB_TRACK] }),
        );
        mockGetRecordingIsrc.mockResolvedValue(answeredWith("FRX451500123"));
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [{ name: "synthwave", count: 2 }] }));

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        expect(mockLookupRecordingsByIsrc).not.toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).toBe(MB_TRACK);
        expect(await stageWrittenDone("acoustid")).toBe(true);
    });

    it("stores the fingerprint and answers the question as Absent when nothing matches", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            kind: "absent",
            evidence: { fingerprint: FINGERPRINT },
        });

        const before = await trackRow();
        const result = await identifyTrack(TRACK_ID);

        // Nothing matched — an answer, not a failure: the record settles
        // `done` on the no-match evidence, and the Track row is not written.
        expect(result).toBe("no_match");
        expect(await trackRow()).toEqual(before);
        expect(mockPersistAcoustidFingerprint).toHaveBeenCalledWith(TRACK_ID, FINGERPRINT);
        expect(await stageWrittenDone("acoustid")).toBe(true);
    });

    it("answers from the album's tracklist before the name search", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            answeredWith({
                releaseGroupMbid: RG_MBID,
                releaseMbid: REL_MBID,
                originalYear: 1997,
                label: "Some Labels",
                genres: [
                    { name: "electronic", count: 5 },
                    { name: "ambient", count: 2 },
                ],
                recordings: [
                    {
                        recordingId: MB_TRACK,
                        title: "Cheerleader Effect",
                        durationMs: 218000,
                        isrcs: ["GBAYE0601498"],
                        genres: [{ name: "trip-hop", count: 3 }],
                        artists: ["Carpenter Brut"],
                    },
                ],
            }),
        );

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockGetAlbumCatalogue).toHaveBeenCalledWith(RG_MBID);
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        // AcoustID was asked first and knew nothing; the tracklist then named the recording.
        expect(mockIdentifyTrackByAcoustid.mock.invocationCallOrder[0]).toBeLessThan(
            mockGetAlbumCatalogue.mock.invocationCallOrder[0],
        );
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        // The ISRC and the genres come from the tracklist row; the album row gets
        // its year, label and genres filled from the same fetch.
        expect(await trackRow()).toMatchObject({ isrc: "GBAYE0601498", isrcSource: "musicbrainz" });
        expect(mockPopulateTrackGenres).toHaveBeenCalledWith(TRACK_ID, ["trip-hop"]);
        expect(await albumRow()).toMatchObject({
            year: 1997,
            label: "Some Labels",
            genres: ["electronic", "ambient"],
        });
        expect(await stageWrittenDone("musicbrainz")).toBe(true);
    });

    it("does not take a tracklist entry whose length says it is another version", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            answeredWith({
                releaseGroupMbid: RG_MBID,
                releaseMbid: REL_MBID,
                originalYear: null,
                label: null,
                genres: [],
                recordings: [
                    { recordingId: "radio-edit", title: "Cheerleader Effect", durationMs: 160000, isrcs: [], genres: [], artists: ["Carpenter Brut"] },
                ],
            }),
        );

        await identifyTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).not.toBe("radio-edit");
    });

    it("defers without falling through to the search when the tracklist call fails", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue({
            kind: "transient",
            error: { code: "NETWORK", message: "boom", retryable: true, retryAfterMs: 60_000 },
        });

        const result = await identifyTrack(TRACK_ID);

        // MusicBrainz failing outright defers with the real cause; the rest of
        // the MusicBrainz ladder is not asked while the source is down.
        expect(result).toBe("deferred");
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).toBeNull();
    });

    it("records a source that ran out of time as a timeout, and any other throw as a failed request", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        const failOutcome = jest.spyOn(stageRecords, "failOutcome");
        try {
            mockGetAlbumCatalogue.mockRejectedValueOnce(new TimeoutError("musicbrainz did not answer in time"));
            expect(await identifyTrack(TRACK_ID)).toBe("deferred");
            expect(failOutcome.mock.calls[0][3]).toMatchObject({ kind: "transient", error: { code: "TIMEOUT" } });

            failOutcome.mockClear();
            mockGetAlbumCatalogue.mockRejectedValueOnce(new Error("socket hang up"));
            expect(await identifyTrack(TRACK_ID)).toBe("deferred");
            expect(failOutcome.mock.calls[0][3]).toMatchObject({ kind: "transient", error: { code: "REQUEST_FAILED" } });
        } finally {
            failOutcome.mockRestore();
        }
    });

    it("asks AcoustID even with the fpcalc flag off — the step needs a fingerprint, not the binary", async () => {
        mockGetFeatures.mockResolvedValue({ fpcalc: false });

        await identifyTrack(TRACK_ID);

        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
    });

    it("reads the file's recording id before its ISRC", async () => {
        await seedTrack({ isrc: "USRC17607839" });
        mockReadTags.mockResolvedValue({ recordingMbid: RECORDING, fingerprint: null, artists: [], duration: 218 });

        await identifyTrack(TRACK_ID);

        expect(mockLookupRecordingsByIsrc).not.toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).toBe(RECORDING);
    });

    it("takes the ISRC's recording that is this track, not the first one listed", async () => {
        await seedTrack({ isrc: "USRC17607839" });
        mockLookupRecordingsByIsrc.mockResolvedValue(
            answeredWith([
                { id: "live-2014", title: "Cheerleader Effect (Live 2014)", lengthMs: 240000, artists: ["Carpenter Brut"] },
                { id: "other-song", title: "Decode", lengthMs: 218000, artists: ["Carpenter Brut"] },
                { id: "studio", title: "Cheerleader Effect", lengthMs: 218400, artists: ["Carpenter Brut"] },
            ]),
        );

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect((await trackRow()).recordingMbid).toBe("studio");
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        // The file's own ISRC is never replaced.
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
    });

    it("goes on down the ladder when none of the ISRC's recordings is this track", async () => {
        await seedTrack({ isrc: "USRC17607839" });
        mockLookupRecordingsByIsrc.mockResolvedValue(
            answeredWith([{ id: "other-song", title: "Decode", lengthMs: 218000, artists: ["Paramore"] }]),
        );

        await identifyTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).not.toBe("other-song");
    });

    it("never sends a code that is not an ISRC", async () => {
        await seedTrack({ isrc: "PMEDIA" });

        await identifyTrack(TRACK_ID);

        expect(mockLookupRecordingsByIsrc).not.toHaveBeenCalled();
        expect(mockIdentifyRecording).toHaveBeenCalled();
    });

    it("replaces an ISRC MusicBrainz gave for an earlier answer with the new answer's", async () => {
        await seedTrack({ isrc: "GBAYE0601498", isrcSource: "musicbrainz" });
        mockLookupRecordingsByIsrc.mockResolvedValue(
            answeredWith([{ id: "other-song", title: "Decode", lengthMs: 218000, artists: ["Paramore"] }]),
        );
        mockIdentifyRecording.mockResolvedValue(answeredWith({ id: MB_TRACK, title: "Cheerleader Effect", lengthMs: 218000, artists: ["Carpenter Brut"] }));
        mockGetRecordingIsrc.mockResolvedValue(answeredWith("FRX451500123"));

        await identifyTrack(TRACK_ID);

        expect(await trackRow()).toMatchObject({ isrc: "FRX451500123", isrcSource: "musicbrainz" });
    });
});

describe("the album's tracklist answers before any per-track MusicBrainz call", () => {
    const tracklist = (
        recordings: Array<{ recordingId: string; title: string; durationMs: number; isrcs: string[]; artists?: string[] }>,
    ) =>
        answeredWith({
            releaseGroupMbid: RG_MBID,
            releaseMbid: REL_MBID,
            originalYear: 2015,
            label: null,
            genres: [{ name: "synthwave", count: 3 }],
            recordings: recordings.map((r) => ({
                artists: ["Carpenter Brut"],
                ...r,
                genres: [{ name: "synthwave", count: 2 }],
            })),
        });

    it("finds an ISRC track in its album's tracklist without looking the ISRC up", async () => {
        await seedTrack({ rgMbid: RG_MBID, isrc: "USRC17607839" });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([
                { recordingId: "other", title: "Decode", durationMs: 218000, isrcs: ["USRC17600001"] },
                { recordingId: "studio", title: "Cheerleader Effect", durationMs: 218400, isrcs: ["USRC17607839"] },
            ]),
        );

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockLookupRecordingsByIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).toBe("studio");
    });

    it("on a compilation, the row credited to the track's artist wins over a same-titled song", async () => {
        for (const order of [0, 1]) {
            jest.clearAllMocks();
            await seedTrack({ rgMbid: RG_MBID });
            const rows = [
                { recordingId: "someone-else", title: "Cheerleader Effect", durationMs: 217000, isrcs: [], artists: ["Other Band"] },
                { recordingId: "ours", title: "Cheerleader Effect", durationMs: 219500, isrcs: [], artists: ["Carpenter Brut"] },
            ];
            mockGetAlbumCatalogue.mockResolvedValue(tracklist(order ? rows.reverse() : rows));

            await identifyTrack(TRACK_ID);

            expect((await trackRow()).recordingMbid).toBe("ours");
        }
    });

    it("the album vouches for a credit written another way when one row alone is the track", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([
                { recordingId: "studio", title: "Cheerleader Effect", durationMs: 218400, isrcs: [], artists: ["カーペンター・ブルート"] },
                { recordingId: "other", title: "Decode", durationMs: 218000, isrcs: [], artists: ["カーペンター・ブルート"] },
            ]),
        );

        await identifyTrack(TRACK_ID);

        expect((await trackRow()).recordingMbid).toBe("studio");
    });

    it("two uncredited rows that could both be the track: the album vouches for neither", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([
                { recordingId: "first", title: "Cheerleader Effect", durationMs: 217000, isrcs: [], artists: ["Other Band"] },
                { recordingId: "second", title: "Cheerleader Effect", durationMs: 219500, isrcs: [], artists: ["Third Band"] },
            ]),
        );
        mockIdentifyRecording.mockResolvedValue(noData);

        await identifyTrack(TRACK_ID);

        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect((await trackRow()).recordingMbid ?? "").not.toMatch(/first|second/);
    });

    it("an ISRC row that is another recording is not taken; the ISRC lookup comes next", async () => {
        await seedTrack({ rgMbid: RG_MBID, isrc: "USRC17607839" });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([{ recordingId: "mislabelled", title: "Decode", durationMs: 300000, isrcs: ["USRC17607839"] }]),
        );

        await identifyTrack(TRACK_ID);

        expect(mockLookupRecordingsByIsrc).toHaveBeenCalledWith("USRC17607839");
        expect((await trackRow()).recordingMbid).not.toBe("mislabelled");
    });

    it("a file's recording tag takes its ISRC and genres from its row in the tracklist", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        mockReadTags.mockResolvedValue({ recordingMbid: RECORDING, fingerprint: null, artists: [], duration: 218 });
        mockGetAlbumCatalogue.mockResolvedValue(
            tracklist([{ recordingId: RECORDING, title: "Cheerleader Effect", durationMs: 218400, isrcs: ["FRX451500123"] }]),
        );

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).toBe(RECORDING);
    });

    it("a file's recording tag still answers when the album's tracklist cannot be fetched", async () => {
        await seedTrack({ rgMbid: RG_MBID });
        mockReadTags.mockResolvedValue({ recordingMbid: RECORDING, fingerprint: null, artists: [], duration: 218 });
        mockGetAlbumCatalogue.mockResolvedValue({
            kind: "transient",
            error: { code: "NETWORK", message: "boom", retryable: true, retryAfterMs: 60_000 },
        });
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [] }));

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockGetRecordingGenres).toHaveBeenCalledWith(RECORDING);
    });
});

describe("AcoustID paused", () => {
    it("the question waits for the pause to end and uses up no retry", async () => {
        const until = new Date(Date.now() + 30 * 60_000);
        const pause = jest.spyOn(sourcePauseController, "getPause").mockResolvedValue({
            source: "acoustid", until, code: "RATE_LIMITED", message: null,
        } as any);
        // The engine has claimed the question twice already.
        await putStage(TRACK_ID, "recording", "working", { attempt: 2, seedError: false, source: "musicbrainz" });

        // The queue job names the claim it answers: attempt 2, never redelivered.
        const result = await identifyTrack(TRACK_ID, `${TRACK_ID}-2-r0`);

        expect(result).toBe("deferred");
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        // Parked pending with the cause, and the attempt and failure counts of the record that was there stay as they were.
        const parked = await recordingStage();
        expect(parked).toMatchObject({ status: "pending", lastErrorCode: "RATE_LIMITED", attempt: 2, failures: 0 });
        pause.mockRestore();
    });
});

describe("AcoustID first, and the album it names", () => {
    // Real ids and titles from a recorded AcoustID batch reply
    // (services/__tests__/fixtures/acoustid/batch-lookup-3.json):
    // AcoustID lists a compilation first and the album the file is on third.
    const FUTURE_CLUB = "ac559309-3f00-4db6-95ce-1c1dca916677";
    const DANGEROUS_DAYS = "f765fa78-96b2-4a72-b8c7-c1d7eecbae92";
    const ACOUSTID_ALBUMS = [
        { id: "e6482892-aa9c-43da-bd31-b4d0a617bb53", title: "Discoteka 2018 Synthwave Dance Music" },
        { id: "51bf5516-af54-4668-b9a4-0bb1f36661f9", title: "Hotline Miami 2: Wrong Number" },
        { id: DANGEROUS_DAYS, title: "Dangerous Days" },
    ];
    const dangerousDays = (rows: Array<{ recordingId: string; title: string }>) =>
        answeredWith({
            releaseGroupMbid: DANGEROUS_DAYS,
            releaseMbid: "95353672-acb7-4bb4-ad41-a5e52e51bdc6",
            originalYear: 2014,
            label: "Blood Music",
            genres: [],
            recordings: rows.map((r) => ({
                ...r,
                durationMs: 289000,
                isrcs: ["TCABW1462862"],
                genres: [{ name: "electronic", count: 3 }, { name: "synthwave", count: 3 }],
                artists: ["Perturbator"],
            })),
        });
    const seedFutureClub = (rgMbid = "temp-1693-abc", rgMbidSource: string | null = null) =>
        seedSong({
            title: "Future Club",
            artist: "Perturbator",
            albumTitle: "Dangerous Days",
            filePath: "/music/zz-aco/Perturbator/Dangerous Days/04 Future Club.mp3",
            duration: 289,
            fingerprint: FINGERPRINT,
            rgMbid,
            rgMbidSource,
        });
    const acoustidAnswers = (candidates: string[]) =>
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: candidates[0], releaseGroups: ACOUSTID_ALBUMS, candidates }),
        );

    it("an album still without an id: no tracklist per song, the song pays its own details request", async () => {
        await seedFutureClub();
        acoustidAnswers([FUTURE_CLUB]);
        mockGetRecordingIsrc.mockResolvedValue(answeredWith("TCABW1462862"));
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [{ name: "synthwave", count: 3 }] }));

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        // The album's id is decided once, by the album step's vote, never by one song.
        expect(mockGetAlbumCatalogue).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).toHaveBeenCalledWith(FUTURE_CLUB);
        expect(await albumRow()).toMatchObject({ year: null, label: null, genres: null });
        expect(await stageWrittenDone("acoustid")).toBe(true);
    });

    it("an album the AcoustID vote named: its tracklist by the row's id gives ISRC and genres", async () => {
        await seedFutureClub(DANGEROUS_DAYS, "acoustid");
        acoustidAnswers([FUTURE_CLUB]);
        mockGetAlbumCatalogue.mockResolvedValue(dangerousDays([{ recordingId: FUTURE_CLUB, title: "Future Club" }]));

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockGetAlbumCatalogue).toHaveBeenCalledWith(DANGEROUS_DAYS);
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        expect(mockPopulateTrackGenres).toHaveBeenCalledWith(TRACK_ID, ["electronic", "synthwave"]);
        expect(await trackRow()).toMatchObject({ isrc: "TCABW1462862", isrcSource: "musicbrainz" });
        const stage = await recordingStage();
        expect(stage?.status).toBe("done");
        expect(JSON.stringify(stage?.evidence)).toContain("the album's id from the AcoustID vote");
    });

    it("takes AcoustID's candidate that is on this album's tracklist", async () => {
        await seedFutureClub(DANGEROUS_DAYS, "acoustid");
        acoustidAnswers(["compilation-recording", FUTURE_CLUB]);
        mockGetAlbumCatalogue.mockResolvedValue(dangerousDays([{ recordingId: FUTURE_CLUB, title: "Future Club" }]));

        await identifyTrack(TRACK_ID);

        expect((await trackRow()).recordingMbid).toBe(FUTURE_CLUB);
    });

    it("the album row's own id wins over AcoustID's albums, and that album is filled", async () => {
        await seedFutureClub(DANGEROUS_DAYS);
        acoustidAnswers([FUTURE_CLUB]);
        mockGetAlbumCatalogue.mockResolvedValue(dangerousDays([{ recordingId: FUTURE_CLUB, title: "Future Club" }]));

        await identifyTrack(TRACK_ID);

        expect(mockGetAlbumCatalogue).toHaveBeenCalledWith(DANGEROUS_DAYS);
        expect(await albumRow()).toMatchObject({ year: 2014, label: "Blood Music" });
    });

    it("the album row's own tracklist fills the album even when AcoustID's recording is not on it", async () => {
        await seedFutureClub(DANGEROUS_DAYS);
        acoustidAnswers(["remaster-recording"]);
        mockGetAlbumCatalogue.mockResolvedValue(dangerousDays([{ recordingId: FUTURE_CLUB, title: "Future Club" }]));
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [{ name: "synthwave", count: 1 }] }));

        await identifyTrack(TRACK_ID);

        expect((await trackRow()).recordingMbid).toBe("remaster-recording");
        expect(await albumRow()).toMatchObject({ year: 2014, label: "Blood Music" });
    });

    it("an AcoustID pick with only the track's length goes last: the tracklist's name match wins", async () => {
        await seedFutureClub(DANGEROUS_DAYS);
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: "studio-not-live", releaseGroups: ACOUSTID_ALBUMS, candidates: ["studio-not-live"], titleAgrees: false }),
        );
        mockGetAlbumCatalogue.mockResolvedValue(dangerousDays([{ recordingId: FUTURE_CLUB, title: "Future Club" }]));

        await identifyTrack(TRACK_ID);

        expect((await trackRow()).recordingMbid).toBe(FUTURE_CLUB);
        expect((await trackRow()).recordingMbid).not.toBe("studio-not-live");
    });

    it("an AcoustID pick with only the track's length is taken when nothing else names the recording", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: "length-only", releaseGroups: [], candidates: ["length-only"], titleAgrees: false }),
        );
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [] }));

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).toBe("length-only");
        expect(await stageWrittenDone("acoustid")).toBe(true);
    });

    it("the album row is not filled when neither this track's recording nor its name is on the tracklist", async () => {
        await seedFutureClub(DANGEROUS_DAYS);
        acoustidAnswers(["remaster-recording"]);
        mockGetAlbumCatalogue.mockResolvedValue(dangerousDays([{ recordingId: "other-song", title: "Sentient" }]));
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [] }));

        await identifyTrack(TRACK_ID);

        expect(await albumRow()).toMatchObject({ year: null, label: null, genres: null });
    });

    it("a length-only AcoustID pick loses to the file's ISRC", async () => {
        await seedTrack({ isrc: "USRC17607839" });
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: "length-only", releaseGroups: [], candidates: ["length-only"], titleAgrees: false }),
        );
        mockLookupRecordingsByIsrc.mockResolvedValue(
            answeredWith([{ id: "studio", title: "Cheerleader Effect", lengthMs: 218400, artists: ["Carpenter Brut"] }]),
        );

        await identifyTrack(TRACK_ID);

        expect((await trackRow()).recordingMbid).toBe("studio");
    });

    it("a MusicBrainz failure defers the track instead of taking a length-only AcoustID pick", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: "length-only", releaseGroups: [], candidates: ["length-only"], titleAgrees: false }),
        );
        mockIdentifyRecording.mockResolvedValue({
            kind: "transient",
            error: { code: "NETWORK", message: "boom", retryable: true, retryAfterMs: 60_000 },
        });

        expect(await identifyTrack(TRACK_ID)).toBe("deferred");
        expect((await trackRow()).recordingMbid).toBeNull();
    });

    it("a length-only pick on the fetched tracklist takes its ISRC and genres from it", async () => {
        await seedFutureClub(DANGEROUS_DAYS);
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: FUTURE_CLUB, releaseGroups: ACOUSTID_ALBUMS, candidates: [FUTURE_CLUB], titleAgrees: false }),
        );
        // The tracklist row's title is not the file's, so the name match finds nothing.
        mockGetAlbumCatalogue.mockResolvedValue(dangerousDays([{ recordingId: FUTURE_CLUB, title: "Future Club (Extended)" }]));

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect((await trackRow()).recordingMbid).toBe(FUTURE_CLUB);
        expect(mockGetRecordingGenres).not.toHaveBeenCalled();
        expect(mockGetRecordingIsrc).not.toHaveBeenCalled();
        // Its recording is on the album row's own tracklist: the album is filled.
        expect(await albumRow()).toMatchObject({ year: 2014, label: "Blood Music" });
    });

    it("AcoustID failing does not stop MusicBrainz from answering", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            kind: "transient",
            error: { code: "REQUEST_FAILED", message: "503", retryable: true, retryAfterMs: 60_000 },
        });
        mockIdentifyRecording.mockResolvedValue(answeredWith({ id: MB_TRACK, title: "Cheerleader Effect", lengthMs: 218000, artists: ["Carpenter Brut"] }));

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("identified");
        expect((await trackRow()).recordingMbid).toBe(MB_TRACK);
    });

    it("AcoustID failing and MusicBrainz knowing nothing: the record waits for AcoustID", async () => {
        mockIdentifyTrackByAcoustid.mockResolvedValue({
            kind: "transient",
            error: { code: "REQUEST_FAILED", message: "503", retryable: true, retryAfterMs: 60_000 },
        });

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("deferred");
        expect(mockIdentifyRecording).toHaveBeenCalled();
        expect((await trackRow()).recordingMbid).toBeNull();
    });
});

describe("AcoustID paused: a saved reply is still used, and no lower source answers in its place", () => {
    const pauseAcoustid = () =>
        jest.spyOn(sourcePauseController, "getPause").mockResolvedValue({
            source: "acoustid", until: new Date(Date.now() + 30 * 60_000), code: "RATE_LIMITED", message: null,
        } as any);

    it("with no saved reply, a lower source does not name the recording", async () => {
        const pause = pauseAcoustid();
        mockIdentifyRecording.mockResolvedValue(answeredWith({ id: MB_TRACK }));
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [] }));

        const result = await identifyTrack(TRACK_ID);

        pause.mockRestore();
        expect(mockIdentifyRecording).not.toHaveBeenCalled();
        expect(result).toBe("deferred");
    });

    it("with a saved reply for the song's fingerprint, AcoustID answers from it", async () => {
        const pause = pauseAcoustid();
        mockReadTags.mockResolvedValue({ recordingMbid: null, fingerprint: FINGERPRINT, artists: [], duration: 218 });
        const saved = jest.spyOn(acoustidService, "savedAnswer").mockResolvedValue({ recordingMbid: MB_TRACK } as any);
        mockIdentifyTrackByAcoustid.mockResolvedValue(
            answeredWith({ source: "acoustid", recordingMbid: MB_TRACK, candidates: [MB_TRACK], titleAgrees: true, fingerprint: FINGERPRINT }),
        );
        mockGetRecordingGenres.mockResolvedValue(answeredWith({ genres: [] }));

        const result = await identifyTrack(TRACK_ID);

        pause.mockRestore();
        saved.mockRestore();
        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
        expect(result).toBe("identified");
    });
});

describe("AcoustID paused: a second question is not asked live either", () => {
    it("with the tag fingerprint's saved reply empty and none saved for the stored one, the song defers", async () => {
        const pause = jest.spyOn(sourcePauseController, "getPause").mockResolvedValue({
            source: "acoustid", until: new Date(Date.now() + 30 * 60_000), code: "RATE_LIMITED", message: null,
        } as any);
        mockReadTags.mockResolvedValue({ recordingMbid: null, fingerprint: FINGERPRINT, artists: [], duration: 218 });
        await seedTrack();
        await prisma.track.update({ where: { id: TRACK_ID }, data: { acoustidFingerprint: "STORED-FINGERPRINT" } });
        const answer = jest.spyOn(acoustidService, "savedAnswer").mockImplementation(async (_d, fp) => (fp === FINGERPRINT ? null : undefined));
        const has = jest.spyOn(acoustidService, "hasSavedReply").mockImplementation(async (_d, fp) => fp === FINGERPRINT);

        const result = await identifyTrack(TRACK_ID);

        pause.mockRestore();
        answer.mockRestore();
        has.mockRestore();
        expect(result).toBe("deferred");
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
    });
});

describe("the fingerprint question closed", () => {
    const fingerprintStageIs = (status: string, retryable: boolean) =>
        putStage(TRACK_ID, "fingerprint", status, { retryable, source: "fpcalc" });

    it("a fingerprint stage that failed for good still asks AcoustID with the file's fingerprint tag", async () => {
        mockReadTags.mockResolvedValue({ recordingMbid: null, fingerprint: FINGERPRINT, artists: [], duration: 218 });
        await fingerprintStageIs("failed", false);

        await identifyTrack(TRACK_ID);

        expect(mockIdentifyTrackByAcoustid).toHaveBeenCalled();
    });

    it("a fingerprint set aside by a person closes the song as no match, not as a permanent failure", async () => {
        await fingerprintStageIs("blocked", true);

        const result = await identifyTrack(TRACK_ID);

        expect(result).toBe("no_match");
        expect(mockIdentifyTrackByAcoustid).not.toHaveBeenCalled();
        expect(await stageWrittenDone("acoustid")).toBe(true);
        const stage = await recordingStage();
        expect(JSON.stringify(stage?.evidence)).toContain("not asked");
        expect(stage).toMatchObject({ lastErrorCode: null, failureClass: null });
    });
});
