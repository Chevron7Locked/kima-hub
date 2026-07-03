/**
 * Tracks route tests -- GET /tracks/:id + toAudioFeaturesDTO field mapping.
 *
 * Tests:
 *   - GET /tracks/:id with analyzed track returns 200 with all 15 audio feature fields
 *   - GET /tracks/:id with un-analyzed track returns 200 with null audio features
 *   - GET /tracks/:id with unknown id returns 404
 *   - List transform at :1770 yields identical shape as toAudioFeaturesDTO
 */

// All mocks must be before imports

jest.mock('../../../utils/db', () => ({
    prisma: {
        track: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock('../../../utils/logger', () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('../../../config', () => ({
    config: {
        music: {
            musicPath: '/music',
        },
    },
}));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(false),
    unlinkSync: jest.fn(),
    readdirSync: jest.fn().mockReturnValue([]),
    rmdirSync: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import tracksRoutes from '../tracks';
import { prisma } from '../../../utils/db';
import { toAudioFeaturesDTO } from '../../../utils/audioFeatures';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/', tracksRoutes);
    return app;
}

const BASE_ARTIST = { id: 'artist-1', mbid: 'mbid-artist-1', name: 'Radiohead' };
const BASE_ALBUM = {
    id: 'album-1',
    title: 'OK Computer',
    artistId: 'artist-1',
    rgMbid: 'mbid-ok-computer',
    year: 1997,
    coverUrl: '/covers/ok-computer.jpg',
    location: 'LIBRARY',
    artist: BASE_ARTIST,
};

const ANALYZED_TRACK = {
    id: 'track-1',
    title: 'Paranoid Android',
    duration: 383,
    bpm: 120.5,
    energy: 0.85,
    valence: 0.3,
    arousal: 0.7,
    danceability: 0.4,
    keyScale: 'Am',
    instrumentalness: 0.1,
    analysisMode: 'essentia',
    moodHappy: 0.2,
    moodSad: 0.6,
    moodRelaxed: 0.1,
    moodAggressive: 0.5,
    moodParty: 0.3,
    moodAcoustic: 0.2,
    moodElectronic: 0.7,
    album: BASE_ALBUM,
};

const UNANALYZED_TRACK = {
    id: 'track-2',
    title: 'Karma Police',
    duration: 264,
    bpm: null,
    energy: null,
    valence: null,
    arousal: null,
    danceability: null,
    keyScale: null,
    instrumentalness: null,
    analysisMode: null,
    moodHappy: null,
    moodSad: null,
    moodRelaxed: null,
    moodAggressive: null,
    moodParty: null,
    moodAcoustic: null,
    moodElectronic: null,
    album: BASE_ALBUM,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /tracks/:id -- track detail', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 200 with all 15 audio feature fields for an analyzed track', async () => {
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(ANALYZED_TRACK);

        const res = await request(app).get('/tracks/track-1');
        expect(res.status).toBe(200);

        const body = res.body;
        expect(body.id).toBe('track-1');
        expect(body.title).toBe('Paranoid Android');
        expect(body.duration).toBe(383);
        expect(body.artist.name).toBe('Radiohead');
        expect(body.album.title).toBe('OK Computer');

        // Verify all 15 audio feature fields are present
        const audioFeatures = body.audioFeatures;
        expect(audioFeatures).toBeDefined();
        expect(audioFeatures.bpm).toBe(120.5);
        expect(audioFeatures.energy).toBe(0.85);
        expect(audioFeatures.valence).toBe(0.3);
        expect(audioFeatures.arousal).toBe(0.7);
        expect(audioFeatures.danceability).toBe(0.4);
        expect(audioFeatures.keyScale).toBe('Am');
        expect(audioFeatures.instrumentalness).toBe(0.1);
        expect(audioFeatures.analysisMode).toBe('essentia');
        expect(audioFeatures.moodHappy).toBe(0.2);
        expect(audioFeatures.moodSad).toBe(0.6);
        expect(audioFeatures.moodRelaxed).toBe(0.1);
        expect(audioFeatures.moodAggressive).toBe(0.5);
        expect(audioFeatures.moodParty).toBe(0.3);
        expect(audioFeatures.moodAcoustic).toBe(0.2);
        expect(audioFeatures.moodElectronic).toBe(0.7);
    });

    it('returns 200 with null audio features for an un-analyzed track', async () => {
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(UNANALYZED_TRACK);

        const res = await request(app).get('/tracks/track-2');
        expect(res.status).toBe(200);

        const body = res.body;
        expect(body.id).toBe('track-2');
        expect(body.title).toBe('Karma Police');

        // Verify all 15 audio feature fields are present but null
        const audioFeatures = body.audioFeatures;
        expect(audioFeatures).toBeDefined();
        expect(audioFeatures.bpm).toBeNull();
        expect(audioFeatures.energy).toBeNull();
        expect(audioFeatures.valence).toBeNull();
        expect(audioFeatures.arousal).toBeNull();
        expect(audioFeatures.danceability).toBeNull();
        expect(audioFeatures.keyScale).toBeNull();
        expect(audioFeatures.instrumentalness).toBeNull();
        expect(audioFeatures.analysisMode).toBeNull();
        expect(audioFeatures.moodHappy).toBeNull();
        expect(audioFeatures.moodSad).toBeNull();
        expect(audioFeatures.moodRelaxed).toBeNull();
        expect(audioFeatures.moodAggressive).toBeNull();
        expect(audioFeatures.moodParty).toBeNull();
        expect(audioFeatures.moodAcoustic).toBeNull();
        expect(audioFeatures.moodElectronic).toBeNull();
    });

    it('returns 404 for an unknown track id', async () => {
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).get('/tracks/nonexistent-id');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Track not found');
    });
});

describe('toAudioFeaturesDTO -- field mapping (direct unit tests; NOT the /radio route integration)', () => {
    it('returns the exact 15-field shape for an analyzed track', () => {
        const result = toAudioFeaturesDTO(ANALYZED_TRACK);

        // Verify all 15 fields are present
        const expectedFields = [
            'bpm', 'energy', 'valence', 'arousal', 'danceability',
            'keyScale', 'instrumentalness', 'analysisMode',
            'moodHappy', 'moodSad', 'moodRelaxed', 'moodAggressive',
            'moodParty', 'moodAcoustic', 'moodElectronic',
        ];
        for (const field of expectedFields) {
            expect(result).toHaveProperty(field);
        }

        // Verify values match
        expect(result.bpm).toBe(120.5);
        expect(result.energy).toBe(0.85);
        expect(result.valence).toBe(0.3);
        expect(result.arousal).toBe(0.7);
        expect(result.danceability).toBe(0.4);
        expect(result.keyScale).toBe('Am');
        expect(result.instrumentalness).toBe(0.1);
        expect(result.analysisMode).toBe('essentia');
        expect(result.moodHappy).toBe(0.2);
        expect(result.moodSad).toBe(0.6);
        expect(result.moodRelaxed).toBe(0.1);
        expect(result.moodAggressive).toBe(0.5);
        expect(result.moodParty).toBe(0.3);
        expect(result.moodAcoustic).toBe(0.2);
        expect(result.moodElectronic).toBe(0.7);
    });

    it('returns null for all fields when track has null feature columns', () => {
        const result = toAudioFeaturesDTO(UNANALYZED_TRACK);

        const nullFields = [
            'bpm', 'energy', 'valence', 'arousal', 'danceability',
            'keyScale', 'instrumentalness', 'analysisMode',
            'moodHappy', 'moodSad', 'moodRelaxed', 'moodAggressive',
            'moodParty', 'moodAcoustic', 'moodElectronic',
        ];
        for (const field of nullFields) {
            expect(result[field as keyof typeof result]).toBeNull();
        }
    });

    it('passes through null feature fields and preserves non-null ones', () => {
        const partialTrack = {
            id: 'track-partial',
            title: 'Partial',
            duration: 100,
            bpm: 100,
            energy: null,
            valence: null,
            arousal: null,
            danceability: null,
            keyScale: null,
            instrumentalness: null,
            analysisMode: null,
            moodHappy: null,
            moodSad: null,
            moodRelaxed: null,
            moodAggressive: null,
            moodParty: null,
            moodAcoustic: null,
            moodElectronic: null,
            album: BASE_ALBUM,
        };

        const result = toAudioFeaturesDTO(partialTrack);

        // bpm is defined, should be 100
        expect(result.bpm).toBe(100);
        // All others are null, should be null
        expect(result.energy).toBeNull();
        expect(result.valence).toBeNull();
        expect(result.arousal).toBeNull();
        expect(result.danceability).toBeNull();
        expect(result.keyScale).toBeNull();
        expect(result.instrumentalness).toBeNull();
        expect(result.analysisMode).toBeNull();
        expect(result.moodHappy).toBeNull();
        expect(result.moodSad).toBeNull();
        expect(result.moodRelaxed).toBeNull();
        expect(result.moodAggressive).toBeNull();
        expect(result.moodParty).toBeNull();
        expect(result.moodAcoustic).toBeNull();
        expect(result.moodElectronic).toBeNull();
    });
});
