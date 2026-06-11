// Podcast range policy tests -- spec 1.7 / B8 / B11 (podcasts half).
//
// Covers the cached-path range handling:
//   - unsatisfiable range  -> 416 with Content-Range: bytes */{fileSize}
//   - multi-range          -> 200 full body
//   - valid range          -> 206 with the requested slice

// Dynamic import of podcastDownload inside the route handler -- mock it.
jest.mock('../../services/podcastDownload', () => ({
    getCachedFilePath: jest.fn(),
    downloadInBackground: jest.fn(),
    isDownloading: jest.fn().mockReturnValue(false),
}));

jest.mock('../../utils/db', () => ({
    prisma: {
        podcastEpisode: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        podcast: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        podcastDownload: {
            deleteMany: jest.fn(),
        },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock('../../middleware/auth', () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    },
}));

jest.mock('../../services/rss-parser', () => ({
    rssParserService: { parseFeed: jest.fn() },
}));

jest.mock('../../services/podcastCache', () => ({
    podcastCacheService: { getPodcasts: jest.fn(), searchPodcasts: jest.fn() },
}));

jest.mock('../../services/deezer', () => ({
    deezerService: { searchPodcasts: jest.fn() },
    mergeAndDedupePodcasts: jest.fn().mockReturnValue([]),
}));

jest.mock('../../utils/ssrf', () => ({
    validateUrlForFetch: jest.fn().mockResolvedValue(null),
}));

import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import podcastRoutes from '../podcasts';
import { prisma } from '../../utils/db';
import * as podcastDownload from '../../services/podcastDownload';

const BASE_EPISODE = {
    id: 'ep-1',
    podcastId: 'pod-1',
    title: 'Episode 1',
    audioUrl: 'http://example.com/ep1.mp3',
    mimeType: 'audio/mpeg',
    fileSize: null,
    guid: 'ep-1-guid',
};

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/podcasts', podcastRoutes);
    return app;
}

// ── Cached-path range policy ──────────────────────────────────────────────────

describe('cached-path range policy (spec 1.7)', () => {
    let app: express.Application;
    let tmpFile: string;
    const FILE_SIZE = 16384; // 16 KB

    beforeAll(async () => {
        tmpFile = path.join(os.tmpdir(), `kima-podcast-test-${Date.now()}.mp3`);
        // Fill with distinct byte pattern to verify slicing.
        const buf = Buffer.alloc(FILE_SIZE);
        for (let i = 0; i < FILE_SIZE; i++) buf[i] = i & 0xff;
        await fs.promises.writeFile(tmpFile, buf);
        app = makeApp();
    });

    afterAll(async () => {
        await fs.promises.unlink(tmpFile).catch(() => {});
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue(BASE_EPISODE);
        (podcastDownload.getCachedFilePath as jest.Mock).mockResolvedValue(tmpFile);
    });

    it('valid range -> 206 with the correct slice', async () => {
        const res = await request(app)
            .get('/podcasts/pod-1/episodes/ep-1/stream')
            .set('Range', 'bytes=0-99');

        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe(`bytes 0-99/${FILE_SIZE}`);
        expect(res.headers['accept-ranges']).toBe('bytes');
        expect(parseInt(res.headers['content-length'])).toBe(100);
        expect(res.body.length).toBe(100);
        // First byte must match position 0 in the file (0 & 0xff = 0).
        expect(res.body[0]).toBe(0);
        // 100th byte must match position 99.
        expect(res.body[99]).toBe(99);
    });

    it('out-of-range -> 416 with Content-Range: bytes */<size>', async () => {
        const res = await request(app)
            .get('/podcasts/pod-1/episodes/ep-1/stream')
            .set('Range', `bytes=${FILE_SIZE + 100}-${FILE_SIZE + 200}`);

        expect(res.status).toBe(416);
        expect(res.headers['content-range']).toBe(`bytes */${FILE_SIZE}`);
    });

    it('multi-range -> 200 with full body', async () => {
        const res = await request(app)
            .get('/podcasts/pod-1/episodes/ep-1/stream')
            .set('Range', 'bytes=0-99,200-299');

        expect(res.status).toBe(200);
        expect(res.body.length).toBe(FILE_SIZE);
    });
});
