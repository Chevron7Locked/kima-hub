/**
 * Streaming route tests -- spec 1.1 (no eviction) and 1.9 (claim release on failure).
 */

jest.mock('../../../utils/db', () => ({
    prisma: {
        track: {
            findUnique: jest.fn(),
        },
        play: {
            findFirst: jest.fn(),
            create: jest.fn(),
        },
        userSettings: {
            findUnique: jest.fn(),
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
            transcodeCachePath: '/cache',
            transcodeCacheMaxGb: 10,
        },
    },
}));

jest.mock('../../../services/audioStreaming', () => ({
    getAudioStreamingService: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import streamingRoutes from '../streaming';
import { prisma } from '../../../utils/db';
import { getAudioStreamingService } from '../../../services/audioStreaming';
import { logger } from '../../../utils/logger';

const TRACK = {
    id: 'track-1',
    filePath: 'Artist/Album/track.mp3',
    fileModified: new Date(),
};

// Unique track for the claim test to avoid collision with the dedup window
// from the concurrency tests above (same module instance, same map).
const TRACK_CLAIM = {
    id: 'track-claim-unique',
    filePath: 'Artist/Album/track2.mp3',
    fileModified: new Date(),
};

function makeApp() {
    const app = express();
    app.use(express.json());
    // The streaming route reads req.user?.id directly without a middleware guard.
    // Inject a synthetic user so all requests are treated as authenticated.
    app.use((req: any, _res: any, next: any) => {
        req.user = { id: 'user-123' };
        next();
    });
    app.use('/', streamingRoutes);
    return app;
}

// ── Spec 1.1: no per-user eviction ───────────────────────────────────────────

describe('GET /tracks/:id/stream -- no per-user eviction (spec 1.1)', () => {
    let app: express.Application;
    let tmpFile: string;

    beforeAll(async () => {
        // Create a temp audio file with enough bytes to make ranged reads meaningful.
        tmpFile = path.join(os.tmpdir(), `kima-test-${Date.now()}.mp3`);
        const buf = Buffer.alloc(65536, 0xaa); // 64 KB of 0xaa bytes
        await fs.promises.writeFile(tmpFile, buf);

        app = makeApp();
    });

    afterAll(async () => {
        await fs.promises.unlink(tmpFile).catch(() => {});
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(TRACK);
        (prisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.play.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.play.create as jest.Mock).mockResolvedValue({});

        const streamingService = {
            getStreamFilePath: jest.fn().mockResolvedValue({
                filePath: tmpFile,
                mimeType: 'audio/mpeg',
            }),
            streamFileWithRangeSupport: jest.fn().mockImplementation(
                async (_req: any, res: any, filePath: string) => {
                    const stat = await fs.promises.stat(filePath);
                    const data = await fs.promises.readFile(filePath);
                    res.setHeader('Content-Type', 'audio/mpeg');
                    res.setHeader('Content-Length', stat.size);
                    res.status(200).end(data);
                }
            ),
        };
        (getAudioStreamingService as jest.Mock).mockReturnValue(streamingService);
    });

    it('two concurrent stream requests for the same user both complete with full bodies', async () => {
        const [r1, r2] = await Promise.all([
            request(app).get('/tracks/track-1/stream'),
            request(app).get('/tracks/track-1/stream'),
        ]);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        // Both responses must carry the full file body.
        expect(r1.body).toBeInstanceOf(Buffer);
        expect(r2.body).toBeInstanceOf(Buffer);
        expect(r1.body.length).toBe(65536);
        expect(r2.body.length).toBe(65536);
    });

    it('three concurrent stream requests for the same user all complete -- no eviction', async () => {
        const [r1, r2, r3] = await Promise.all([
            request(app).get('/tracks/track-1/stream'),
            request(app).get('/tracks/track-1/stream'),
            request(app).get('/tracks/track-1/stream'),
        ]);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r3.status).toBe(200);
        expect(r1.body.length).toBe(65536);
        expect(r2.body.length).toBe(65536);
        expect(r3.body.length).toBe(65536);
    });
});

// ── Spec 1.9: play-log claim release on failure ───────────────────────────────

describe('play-log claim release on failure (spec 1.9)', () => {
    let app: express.Application;
    let tmpFile: string;

    beforeAll(async () => {
        tmpFile = path.join(os.tmpdir(), `kima-test-claim-${Date.now()}.mp3`);
        await fs.promises.writeFile(tmpFile, Buffer.alloc(1024, 0xbb));
        app = makeApp();
    });

    afterAll(async () => {
        await fs.promises.unlink(tmpFile).catch(() => {});
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Use the unique claim track to avoid dedup-window collision with other tests.
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(TRACK_CLAIM);
        (prisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);

        const streamingService = {
            getStreamFilePath: jest.fn().mockResolvedValue({
                filePath: tmpFile,
                mimeType: 'audio/mpeg',
            }),
            streamFileWithRangeSupport: jest.fn().mockImplementation(
                async (_req: any, res: any, filePath: string) => {
                    const data = await fs.promises.readFile(filePath);
                    res.status(200).end(data);
                }
            ),
        };
        (getAudioStreamingService as jest.Mock).mockReturnValue(streamingService);
    });

    it('failed play.create releases the claim so a retry request can log the play', async () => {
        // First request: play.create rejects -- claim should be released.
        (prisma.play.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.play.create as jest.Mock).mockRejectedValueOnce(new Error('DB error'));

        const r1 = await request(app).get('/tracks/track-claim-unique/stream');
        expect(r1.status).toBe(200);

        // Allow the fire-and-forget IIFE to settle.
        await new Promise((r) => setTimeout(r, 50));

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('[STREAM] Failed to log play'),
            expect.anything(),
        );

        // Reset call count before the second request to isolate its behavior.
        (prisma.play.create as jest.Mock).mockClear();
        (prisma.play.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.play.create as jest.Mock).mockResolvedValue({});

        const r2 = await request(app).get('/tracks/track-claim-unique/stream');
        expect(r2.status).toBe(200);

        await new Promise((r) => setTimeout(r, 50));

        // The second request must have attempted play.create (claim was released).
        expect(prisma.play.create).toHaveBeenCalledTimes(1);
    });
});
