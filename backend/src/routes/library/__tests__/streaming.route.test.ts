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
    isQuality: (v: unknown) => typeof v === 'string' && ['original', 'high', 'medium', 'low'].includes(v),
}));

import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import streamingRoutes from '../streaming';
import { prisma } from '../../../utils/db';
import { getAudioStreamingService } from '../../../services/audioStreaming';

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

describe('GET /tracks/:id/stream -- no per-user eviction', () => {
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

// ── A stream request is not a listen ──────────────────────────────────────────
// Plays are recorded by services/playRecording.ts from what was actually heard.

describe('the stream endpoint records no plays', () => {
    let app: express.Application;
    let tmpFile: string;

    beforeAll(async () => {
        tmpFile = path.join(os.tmpdir(), `kima-noplay-${Date.now()}.mp3`);
        await fs.promises.writeFile(tmpFile, Buffer.alloc(4096, 1));
        app = makeApp();
    });

    afterAll(async () => {
        await fs.promises.unlink(tmpFile).catch(() => {});
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(TRACK_CLAIM);
        (prisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.play.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.play.create as jest.Mock).mockResolvedValue({});
        (getAudioStreamingService as jest.Mock).mockReturnValue({
            getStreamFilePath: jest.fn().mockResolvedValue({
                filePath: tmpFile,
                mimeType: 'audio/mpeg',
            }),
            streamFileWithRangeSupport: jest.fn().mockImplementation(
                async (_req: any, res: any, filePath: string) => {
                    const data = await fs.promises.readFile(filePath);
                    res.setHeader('Content-Type', 'audio/mpeg');
                    res.setHeader('Content-Length', data.length);
                    res.status(200).end(data);
                }
            ),
        });
    });

    it('writes nothing to Play, however many times a track is streamed', async () => {
        // Observed failing by restoring the background insert: this reached 1.
        for (let i = 0; i < 3; i++) {
            await request(app).get(`/tracks/${TRACK_CLAIM.id}/stream`).expect(200);
        }
        await new Promise((r) => setTimeout(r, 60));
        expect(prisma.play.create).not.toHaveBeenCalled();
    });

    it('does not even look for a recent play -- that check went with the insert', async () => {
        await request(app).get(`/tracks/${TRACK_CLAIM.id}/stream`).expect(200);
        await new Promise((r) => setTimeout(r, 60));
        expect(prisma.play.findFirst).not.toHaveBeenCalled();
    });

    it('answers 400 for a quality it does not know, before touching the file', async () => {
        const res = await request(app).get(`/tracks/${TRACK_CLAIM.id}/stream?quality=ultra`);
        expect(res.status).toBe(400);
        const pre = await request(app).post(`/tracks/${TRACK_CLAIM.id}/prewarm?quality=ultra`);
        expect(pre.status).toBe(400);
    });
});

// ── A track the scan flagged missing is not streamable ───────────────────────
// It answers not-found instead of failing on the file open.

describe('a file gone from disk before a scan has flagged it', () => {
    const gone = Object.assign(new Error("ENOENT: no such file or directory, stat '/music/x.mp3'"), { code: 'ENOENT' });
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(TRACK);
        (prisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('is not available, not a server error', async () => {
        (getAudioStreamingService as jest.Mock).mockReturnValue({ getStreamFilePath: jest.fn().mockRejectedValue(gone) });
        const res = await request(app).get(`/tracks/${TRACK.id}/stream`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Track not available');
    });

    it('is not available when the fallback to the original finds it gone too', async () => {
        const noFfmpeg = Object.assign(new Error('no ffmpeg'), { code: 'FFMPEG_NOT_FOUND' });
        (getAudioStreamingService as jest.Mock).mockReturnValue({
            getStreamFilePath: jest.fn().mockRejectedValueOnce(noFfmpeg).mockRejectedValueOnce(gone),
        });
        const res = await request(app).get(`/tracks/${TRACK.id}/stream?quality=low`);
        expect(res.status).toBe(404);
    });

    it('stays a server error for anything else', async () => {
        (getAudioStreamingService as jest.Mock).mockReturnValue({
            getStreamFilePath: jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'EACCES' })),
        });
        const res = await request(app).get(`/tracks/${TRACK.id}/stream`);
        expect(res.status).toBe(500);
    });
});

describe('a track flagged missing from disk', () => {
    let app: express.Application;

    beforeAll(() => {
        app = makeApp();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue({
            ...TRACK,
            missingSince: new Date('2026-09-25T12:00:00Z'),
        });
        (prisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('gets a clear not-found, not a 500 from the failed open', async () => {
        const res = await request(app).get(`/tracks/${TRACK.id}/stream`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Track not available');
        // The streaming service was never asked for a file that is not there.
        expect(getAudioStreamingService).not.toHaveBeenCalled();
    });

    it('is not prewarmed either -- prewarming pumps a file that does not exist', async () => {
        const res = await request(app).post(`/tracks/${TRACK.id}/prewarm`);
        expect(res.status).toBe(202);
        expect(getAudioStreamingService).not.toHaveBeenCalled();
    });
});
