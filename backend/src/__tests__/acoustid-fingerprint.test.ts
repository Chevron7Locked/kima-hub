/**
 * The recording stage's AcoustID step reads the fingerprint stage's stored
 * answer and never runs fpcalc itself. A no-match closes the record `done`; a
 * match sets `Track.recordingMbid`. Identification order: file tags, AcoustID by
 * the stored fingerprint, the album tracklist, the ISRC, then the title-checked
 * MusicBrainz name search (which answers alone when no fingerprint is stored).
 */

// ── Mocks ──────────────────────────────────────────────────────────────
// Identification services answer with real `Outcome` kinds; the database is
// real, so stored values land in the migrated schema.

const noData = { kind: "absent", evidence: { mocked: true } } as const;
const answeredWith = (value: unknown) =>
    ({ kind: "answered", value, evidence: { mocked: true } }) as const;

const mockParseFile = jest.fn();
jest.mock("music-metadata", () => ({
    parseFile: (...args: unknown[]) => mockParseFile(...args),
}));

const mockIsAvailable = jest.fn().mockResolvedValue(true);
const mockFingerprintFile = jest.fn();
jest.mock("../services/fpcalc", () => ({
    fpcalcService: {
        isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
        fingerprintFile: (...args: unknown[]) => mockFingerprintFile(...args),
    },
}));

const mockLookup = jest.fn();
jest.mock("../services/acoustidService", () => ({
    acoustidService: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

const mockSearchRecording = jest.fn().mockResolvedValue(noData);
const mockGetRecordingIsrc = jest.fn().mockResolvedValue(noData);
const mockGetRecordingGenres = jest.fn().mockResolvedValue(noData);
const mockLookupByIsrc = jest.fn().mockResolvedValue(noData);
jest.mock("../services/musicbrainz", () => ({
    musicBrainzService: {
        identifyRecording: (...args: unknown[]) => mockSearchRecording(...args),
        getRecordingGenres: (...args: unknown[]) => mockGetRecordingGenres(...args),
        // The real one makes one request for both; here it answers from the two mocks.
        getRecordingIsrcAndGenres: async (id: string) => ({
            isrc: await mockGetRecordingIsrc(id),
            genres: await mockGetRecordingGenres(id),
        }),
        lookupRecordingsByIsrc: (...args: unknown[]) => mockLookupByIsrc(...args),
        getAlbumCatalogue: jest.fn().mockResolvedValue(noData),
        normalizeForSearch: (s: string) => s,
    },
}));

jest.mock("../services/trackIdentity", () => ({
    trackIdentityService: {
        populateTrackGenres: jest.fn().mockResolvedValue(undefined),
    },
}));

const mockGetFeatures = jest.fn().mockResolvedValue({
    musicCNN: false,
    vibeEmbeddings: false,
    audiobookshelfEnabled: false,
    fpcalc: true,
});
jest.mock("../services/featureDetection", () => ({
    featureDetection: { getFeatures: (...args: unknown[]) => mockGetFeatures(...args) },
}));

jest.mock("../services/enrichmentState", () => ({
    enrichmentStateService: {
        updateState: jest.fn().mockResolvedValue({}),
        getState: jest.fn().mockResolvedValue(null),
        initializeState: jest.fn().mockResolvedValue({}),
        clear: jest.fn().mockResolvedValue(undefined),
        detectHang: jest.fn().mockResolvedValue(false),
        clearGate: jest.fn().mockResolvedValue(undefined),
        publishToChannel: jest.fn().mockResolvedValue(undefined),
    },
}));

jest.mock("../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        cleanupOrphanedFailures: jest.fn().mockResolvedValue({ cleaned: 0, checked: 0 }),
        cleanupOldResolved: jest.fn().mockResolvedValue(0),
        recordFailure: jest.fn().mockResolvedValue({}),
        resolveByEntity: jest.fn().mockResolvedValue(true),
    },
}));

const mockRedis = {
    publish: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    set: jest.fn().mockResolvedValue("OK"),
    rpush: jest.fn().mockResolvedValue(1),
    llen: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    status: "ready",
};
jest.mock("ioredis", () => jest.fn(() => mockRedis));

jest.mock("../config", () => ({
    config: {
        redisUrl: "redis://localhost:6379",
        music: { musicPath: "/srv/music" },
    },
}));

jest.mock("../workers/enrichmentQueues", () => ({
    QUEUE_NAMES: {
        ARTISTS: "enrichment-artists",
        TRACKS: "enrichment-tracks",
        VIBE: "enrichment-vibe",
        PODCASTS: "enrichment-podcasts",
    },
    artistQueue: { add: jest.fn() },
    trackQueue: { add: jest.fn() },
    vibeQueue: { add: jest.fn() },
    podcastQueue: { add: jest.fn() },
    closeEnrichmentQueues: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../workers/artistEnrichmentWorker", () => ({
    startArtistEnrichmentWorker: jest.fn().mockResolvedValue({}),
}));
jest.mock("../workers/trackEnrichmentWorker", () => ({
    startTrackEnrichmentWorker: jest.fn().mockResolvedValue({}),
}));
jest.mock("../workers/podcastEnrichmentWorker", () => ({
    startPodcastEnrichmentWorker: jest.fn().mockResolvedValue({}),
}));
jest.mock("../workers/audioCompletionSubscriber", () => ({
    startAudioCompletionSubscriber: jest.fn(),
    stopAudioCompletionSubscriber: jest.fn().mockResolvedValue(undefined),
    haltVibeQueuing: jest.fn(),
    resumeVibeQueuing: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { prisma } from "../utils/db";
import { enrichSingleTrack } from "../workers/unifiedEnrichment";

const PREFIX = "afp";
const id = (n: string) => `${PREFIX}_${n}`;

// Chromaprint-style strings at a real fingerprint's size (about 3.4 kB for a 3-minute song); the step stores and
// forwards them without decoding.
const FINGERPRINT = `AQAD${"afp-t1-".repeat(485)}`;
const TAGGED_FINGERPRINT = `AQAD${"afp-tag".repeat(485)}`;
const RECORDING = "1256eae7-b87d-4c53-9def-108ba484a97d";
const MB_TRACK = "mb-track-afp";

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
}

async function putTrack(data: {
    isrc: string | null;
    recordingMbid?: string | null;
    acoustidFingerprint?: string | null;
}): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Test Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        // A real-shaped release-group id, so the album's tracklist is asked (and answers nothing here).
        data: { id: id("alb"), rgMbid: "5b11f4ce-a62d-471e-81fc-a69a8278c7da", artistId: id("art"), title: "Test Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: id("t1"),
            albumId: id("alb"),
            title: "Test Track",
            trackNo: 1,
            duration: 200,
            filePath: "afp/test-track.flac",
            fileModified: new Date(),
            fileSize: 1000,
            analysisStatus: "pending",
            isrc: data.isrc,
            recordingMbid: data.recordingMbid ?? null,
            acoustidFingerprint: data.acoustidFingerprint ?? null,
        },
    });
    // Seed the per-track recording question the way the migration does it:
    // open, so the sweep must answer it.
    await prisma.$executeRawUnsafe(
        `INSERT INTO "TrackStage"
            (id, "trackId", stage, status, source, attempt, retryable, evidence)
         VALUES ($1, $2, 'recording', 'pending', 'musicbrainz', 0, true, $3::jsonb)`,
        `${id("t1")}__recording`, id("t1"),
        JSON.stringify({ seededFrom: "test" }),
    );
}

async function getStage(): Promise<any> {
    const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "TrackStage" WHERE "trackId" = $1 AND stage = $2`,
        id("t1"), "recording",
    );
    return rows[0];
}

beforeEach(async () => {
    jest.clearAllMocks();
    mockGetFeatures.mockResolvedValue({
        musicCNN: false,
        vibeEmbeddings: false,
        audiobookshelfEnabled: false,
        fpcalc: true,
    });
    mockIsAvailable.mockResolvedValue(true);
    mockSearchRecording.mockResolvedValue(noData);
    mockGetRecordingIsrc.mockResolvedValue(noData);
    mockGetRecordingGenres.mockResolvedValue(noData);
    mockLookupByIsrc.mockResolvedValue(noData);
    await wipe();
});

afterAll(async () => {
    await wipe();
});

describe("AcoustID: the fingerprint is the fingerprint stage's stored answer", () => {
    beforeEach(async () => {
        // No useful tags; the fingerprint stage already answered with a
        // realistic ~3.4 kB fingerprint; the AcoustID lookup finds nothing.
        mockParseFile.mockResolvedValue({ common: {}, format: { duration: 200 } });
        mockFingerprintFile.mockResolvedValue({ duration: 200, fingerprint: FINGERPRINT });
        mockLookup.mockResolvedValue(noData);
        await putTrack({ isrc: null, acoustidFingerprint: FINGERPRINT });
    });

    it("asks with the stored fingerprint; a real miss is the answer", async () => {
        await enrichSingleTrack(id("t1"));

        // Never a second fpcalc run — the recording stage reads what the
        // fingerprint stage stored.
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).toHaveBeenCalledWith(200, FINGERPRINT, { title: "Test Track" });

        const track = await prisma.track.findUnique({
            where: { id: id("t1") },
            select: { acoustidFingerprint: true, recordingMbid: true },
        });
        // The fingerprint is untouched — nothing recomputed it.
        expect(track?.acoustidFingerprint).toBe(FINGERPRINT);
        // Nothing matched, so no recording is invented.
        expect(track?.recordingMbid).toBeNull();
    });

    it("closes the question as answered when the lookup does not match", async () => {
        await enrichSingleTrack(id("t1"));

        const record = await getStage();
        // A correct "no" is an answer: the record closes `done`, the
        // retry ladder is untouched (the question was seeded `pending`
        // at attempt 0), and the evidence says who was asked.
        expect(record.status).toBe("done");
        expect(record.attempt).toBe(0);
        expect(record.failureClass).toBeNull();
        expect(record.nextRetryAt).toBeNull();
        expect(record.evidence.reason).toBe(
            "no source has a recording that is this track",
        );
        expect(record.evidence.asked).toEqual(["acoustid", "album-catalogue", "mb-search"]);
    });

    it("no stored fingerprint anywhere: the step refuses — no fpcalc, no fake answer", async () => {
        // The fingerprint gate normally keeps this step unoffered. Called
        // directly, it refuses without running fpcalc and closes the record as
        // a permanent failure with the reason.
        await wipe();
        mockLookup.mockClear();
        await putTrack({ isrc: null, acoustidFingerprint: null });

        await enrichSingleTrack(id("t1"));

        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();

        const record = await getStage();
        // A real answer: the step refused with NO_FINGERPRINT (permanent),
        // so the question closes rather than ride a retry ladder back to
        // the same refusal — and the record carries the real reason.
        expect(record.status).toBe("failed");
        expect(record.retryable).toBe(false);
        expect(record.lastErrorMessage).toBeTruthy();

        const track = await prisma.track.findUnique({
            where: { id: id("t1") },
            select: { recordingMbid: true },
        });
        expect(track?.recordingMbid).toBeNull();
    });
});

describe("AcoustID: a matched recording is stored in Track.recordingMbid", () => {
    beforeEach(async () => {
        mockParseFile.mockResolvedValue({ common: {}, format: { duration: 200 } });
        mockFingerprintFile.mockResolvedValue({ duration: 200, fingerprint: FINGERPRINT });
        mockLookup.mockResolvedValue(
            answeredWith({
                recordingMbid: RECORDING,
                artistMbid: "artist-mbid",
                releaseGroups: [{ id: "rg-mbid", title: "Test Album" }],
                candidates: [RECORDING],
                title: "Test Track",
                artist: "Test Artist",
            }),
        );
        mockGetRecordingIsrc.mockResolvedValue(answeredWith("USX112345678"));
        mockGetRecordingGenres.mockResolvedValue(
            answeredWith({
                genres: [{ name: "electronic", count: 3 }],
                tags: [{ name: "electronic", count: 3 }],
            }),
        );
        await putTrack({ isrc: null, acoustidFingerprint: FINGERPRINT });
    });

    it("writes the matched recording MBID to Track.recordingMbid", async () => {
        await enrichSingleTrack(id("t1"));

        const track = await prisma.track.findUnique({
            where: { id: id("t1") },
            select: { recordingMbid: true, acoustidFingerprint: true },
        });
        expect(track?.recordingMbid).toBe(RECORDING);
        expect(track?.acoustidFingerprint).toBe(FINGERPRINT);
    });

    it("answers the recording question from the stored fingerprint, with the source recorded", async () => {
        await enrichSingleTrack(id("t1"));

        const record = await getStage();
        expect(record.status).toBe("done");
        // The answer came from AcoustID, asked with the fingerprint stage's stored value.
        expect(record.source).toBe("acoustid");
        expect(record.evidence).toEqual(
            expect.objectContaining({ recordingMbid: RECORDING, fingerprintFrom: "stored" }),
        );
    });
});

describe("AcoustID: the identification order", () => {
    afterEach(async () => {
        await wipe();
    });

    it("takes the file's musicbrainz_recordingid tag with no network call at all", async () => {
        mockParseFile.mockResolvedValue({
            common: {
                musicbrainz_recordingid: [RECORDING],
                acoustid_fingerprint: [TAGGED_FINGERPRINT],
            },
            format: { duration: 200 },
        });
        await putTrack({ isrc: null });

        await enrichSingleTrack(id("t1"));

        expect(mockSearchRecording).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();

        const track = await prisma.track.findUnique({
            where: { id: id("t1") },
            select: { recordingMbid: true, acoustidFingerprint: true },
        });
        expect(track?.recordingMbid).toBe(RECORDING);
        // The tag's fingerprint is stored too — dedupe value, zero cost.
        expect(track?.acoustidFingerprint).toBe(TAGGED_FINGERPRINT);
        const record = await getStage();
        expect(record.status).toBe("done");
        expect(record.source).toBe("file_tag");
    });

    it("answers from the title-checked MusicBrainz search when there are no tags and no stored fingerprint to ask AcoustID with", async () => {
        mockParseFile.mockResolvedValue({ common: {}, format: { duration: 200 } });
        mockSearchRecording.mockResolvedValue(
            answeredWith({ id: MB_TRACK, title: "Test Track", lengthMs: 200000, artists: ["Test Artist"] }),
        );
        await putTrack({ isrc: null });

        await enrichSingleTrack(id("t1"));

        // The search answered, so AcoustID is never asked and fpcalc never runs.
        expect(mockSearchRecording).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Test Track", artists: ["Test Artist"] }),
        );
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();

        const track = await prisma.track.findUnique({
            where: { id: id("t1") },
            select: { recordingMbid: true },
        });
        expect(track?.recordingMbid).toBe(MB_TRACK);
        const record = await getStage();
        expect(record.status).toBe("done");
        expect(record.source).toBe("musicbrainz");
    });

    it("asks AcoustID first, with the tag's fingerprint, and skips the name search once it answers", async () => {
        mockParseFile.mockResolvedValue({
            common: { acoustid_fingerprint: TAGGED_FINGERPRINT },
            format: { duration: 200 },
        });
        mockSearchRecording.mockResolvedValue(noData);
        mockLookup.mockResolvedValue(
            answeredWith({
                recordingMbid: RECORDING,
                artistMbid: "artist-mbid",
                releaseGroups: [{ id: "rg-mbid", title: "Test Album" }],
                candidates: [RECORDING],
                title: "Test Track",
                artist: "Test Artist",
            }),
        );
        await putTrack({ isrc: null });

        await enrichSingleTrack(id("t1"));

        // Tags had no recording id → AcoustID is asked first, with the tag's
        // fingerprint instead of running fpcalc again, and its answer ends the
        // search for the recording.
        expect(mockSearchRecording).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).toHaveBeenCalledWith(200, TAGGED_FINGERPRINT, { title: "Test Track" });

        const track = await prisma.track.findUnique({
            where: { id: id("t1") },
            select: { recordingMbid: true, acoustidFingerprint: true },
        });
        expect(track?.recordingMbid).toBe(RECORDING);
        expect(track?.acoustidFingerprint).toBe(TAGGED_FINGERPRINT);
    });

    it("identifies a track by its ISRC when the ISRC's recording is the track", async () => {
        mockParseFile.mockResolvedValue({ common: {}, format: { duration: 200 } });
        mockLookupByIsrc.mockResolvedValue(
            answeredWith([{ id: RECORDING, title: "Test Track", lengthMs: 200000, artists: ["Test Artist"] }]),
        );
        mockGetRecordingGenres.mockResolvedValue(
            answeredWith({
                genres: [{ name: "electronic", count: 3 }],
                tags: [],
            }),
        );
        await putTrack({ isrc: "USX112345678" });

        await enrichSingleTrack(id("t1"));

        expect(mockSearchRecording).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFingerprintFile).not.toHaveBeenCalled();

        const track = await prisma.track.findUnique({
            where: { id: id("t1") },
            select: { recordingMbid: true },
        });
        expect(track?.recordingMbid).toBe(RECORDING);
        const record = await getStage();
        expect(record.status).toBe("done");
        expect(record.source).toBe("isrc");
    });

    it("with the fpcalc flag off and no stored fingerprint, the step refuses — it never runs fpcalc", async () => {
        mockParseFile.mockResolvedValue({ common: {}, format: { duration: 200 } });
        mockGetFeatures.mockResolvedValue({
            musicCNN: false,
            vibeEmbeddings: false,
            audiobookshelfEnabled: false,
            fpcalc: false,
        });
        await putTrack({ isrc: null, acoustidFingerprint: null });

        await enrichSingleTrack(id("t1"));

        expect(mockFingerprintFile).not.toHaveBeenCalled();
        expect(mockLookup).not.toHaveBeenCalled();
        // The name search still answers what it can.
        expect(mockSearchRecording).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Test Track", artists: ["Test Artist"] }),
        );
        const record = await getStage();
        // The fpcalc flag gates the FINGERPRINT stage, not this one. With no
        // fingerprint anywhere the step refuses (waiting is the gate's job):
        // closed as a permanent refusal, not an owed record the sweep
        // re-polls.
        expect(record.status).toBe("failed");
        expect(record.retryable).toBe(false);
    });
});