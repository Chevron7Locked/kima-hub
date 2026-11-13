/**
 * GET /tracks/:id with all 8 audio feature fields, with null features when
 * unanalysed, 404 for an unknown id, and the list transform's matching shape.
 */

import express from 'express';
import request from 'supertest';
import tracksRoutes from '../tracks';
import { prisma } from '../../../utils/db';
import { toAudioFeaturesDTO } from '../../../utils/audioFeatures';
import { closeEngineConnections } from '../../../__tests__/helpers/engineConnections';
import { mountAsServer } from "../../__tests__/helpers/serverMount";

// ── Helpers ───────────────────────────────────────────────────────────────────

const P = 'zz-tracks-detail';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
        req.user = { id: `${P}-user`, username: 'admin', role: 'admin' };
        next();
    });
    mountAsServer(app, '/', tracksRoutes, "/api/library", { standIn: true });
    return app;
}

const BASE_ARTIST = { id: `${P}-artist`, mbid: `${P}-artist-mbid`, name: 'Radiohead' };
const BASE_ALBUM = {
    id: `${P}-album`,
    title: 'OK Computer',
    artistId: BASE_ARTIST.id,
    rgMbid: `${P}-album-rg`,
    year: 1997,
    coverUrl: '/covers/ok-computer.jpg',
    location: 'LIBRARY',
    artist: BASE_ARTIST,
};

const ANALYZED_TRACK = {
    id: `${P}-track-1`,
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
    album: BASE_ALBUM,
};

const UNANALYZED_TRACK = {
    id: `${P}-track-2`,
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
    album: BASE_ALBUM,
};

beforeAll(async () => {
    await prisma.artist.create({
        data: { id: BASE_ARTIST.id, mbid: BASE_ARTIST.mbid, name: BASE_ARTIST.name, normalizedName: 'radiohead', identityKey: `${P}-ik` },
    });
    await prisma.album.create({
        data: {
            id: BASE_ALBUM.id, rgMbid: BASE_ALBUM.rgMbid, artistId: BASE_ARTIST.id, identityKey: BASE_ALBUM.id,
            title: BASE_ALBUM.title, year: BASE_ALBUM.year, coverUrl: BASE_ALBUM.coverUrl, primaryType: 'Album', location: 'LIBRARY',
        },
    });
    for (const { album: _album, ...t } of [ANALYZED_TRACK, UNANALYZED_TRACK]) {
        await prisma.track.create({
            data: { ...t, albumId: BASE_ALBUM.id, trackNo: 1, filePath: `${t.id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await closeEngineConnections();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /tracks/:id -- track detail', () => {
    let app: express.Application;

    beforeAll(() => { app = makeApp(); });

    it('returns 200 with all 8 audio feature fields for an analyzed track', async () => {
        const res = await request(app).get(`/tracks/${ANALYZED_TRACK.id}`);
        expect(res.status).toBe(200);

        const body = res.body;
        expect(body.id).toBe(ANALYZED_TRACK.id);
        expect(body.title).toBe('Paranoid Android');
        expect(body.duration).toBe(383);
        expect(body.artist.name).toBe('Radiohead');
        expect(body.album.title).toBe('OK Computer');

        // Verify all 8 audio feature fields are present
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
    });

    it('returns 200 with null audio features for an un-analyzed track', async () => {
        const res = await request(app).get(`/tracks/${UNANALYZED_TRACK.id}`);
        expect(res.status).toBe(200);

        const body = res.body;
        expect(body.id).toBe(UNANALYZED_TRACK.id);
        expect(body.title).toBe('Karma Police');

        // Verify all 8 audio feature fields are present but null
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
    });

    it('returns 404 for an unknown track id', async () => {
        const res = await request(app).get('/tracks/nonexistent-id');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Track not found');
    });
});

describe('GET /tracks -- album filter', () => {
    it('refuses an albumId given more than once', async () => {
        await request(makeApp()).get('/tracks?albumId=a&albumId=b').expect(400);
    });
});

describe('toAudioFeaturesDTO -- field mapping (direct unit tests; NOT the /radio route integration)', () => {
    it('returns the exact 8-field shape for an analyzed track', () => {
        const result = toAudioFeaturesDTO(ANALYZED_TRACK);

        // All 8 fields are present
        const expectedFields = [
            'bpm', 'energy', 'valence', 'arousal', 'danceability',
            'keyScale', 'instrumentalness', 'analysisMode',
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
    });

    it('returns null for all fields when track has null feature columns', () => {
        const result = toAudioFeaturesDTO(UNANALYZED_TRACK);

        const nullFields = [
            'bpm', 'energy', 'valence', 'arousal', 'danceability',
            'keyScale', 'instrumentalness', 'analysisMode',
        ];
        for (const field of nullFields) {
            expect(result[field as keyof typeof result]).toBeNull();
        }
    });

    it('passes through null feature fields and preserves non-null ones', () => {
        const partialTrack = {
            id: `${P}-track-partial`,
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
    });
});
