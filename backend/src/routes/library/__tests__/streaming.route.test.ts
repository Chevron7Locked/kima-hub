/**
 * GET /tracks/:id/stream and POST /tracks/:id/prewarm. Real router and database, real files in a temporary music
 * root. The streaming service is stood in for by a small one that reads the real file (a transcoder is not what is
 * under test), so a file gone from disk fails the way the real one does.
 */

jest.mock('../../../config', () => ({
    config: {
        music: {
            musicPath: require('path').join(require('os').tmpdir(), `kima-strm-music-${process.pid}`),
            transcodeCachePath: '/cache',
            transcodeCacheMaxGb: 10,
        },
    },
}));

jest.mock('../../../services/audioStreaming', () => ({
    ...jest.requireActual('../../../services/audioStreaming'),
    getAudioStreamingService: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import streamingRoutes from '../streaming';
import { prisma } from '../../../utils/db';
import { config } from '../../../config';
import { getAudioStreamingService } from '../../../services/audioStreaming';
import { expectLog } from '../../../__tests__/helpers/expectedLogs';

const P = 'strm';
const USER = `${P}_user`;
const MUSIC = path.resolve(config.music.musicPath);
const BODY_SIZE = 65536;

function makeApp() {
    const app = express();
    app.use(express.json());
    // The streaming route reads req.user?.id directly without a middleware guard.
    app.use((req: any, _res: any, next: any) => {
        req.user = { id: USER };
        next();
    });
    app.use('/', streamingRoutes);
    return app;
}
const app = makeApp();

/** A streaming service that serves the file it is given and fails, as the real one does, when it is gone. */
function fakeStreamingService(overrides: { getStreamFilePath?: jest.Mock } = {}) {
    return {
        getStreamFilePath: overrides.getStreamFilePath ?? jest.fn(async (_id: string, _q: string, _mtime: Date, absolute: string) => {
            await fs.promises.stat(absolute);
            return { filePath: absolute, mimeType: 'audio/mpeg' };
        }),
        streamFileWithRangeSupport: jest.fn(async (_req: any, res: any, filePath: string) => {
            const data = await fs.promises.readFile(filePath);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', data.length);
            res.status(200).end(data);
        }),
    };
}

/** A song row at `filePath` (relative to the music root); the file itself is written only when `onDisk`. */
async function seedTrack(id: string, filePath: string, opts: { onDisk?: boolean; missingSince?: Date } = {}) {
    await prisma.track.create({
        data: { id: `${P}_${id}`, albumId: `${P}_alb`, title: `${P} ${id}`, trackNo: 1, duration: 100, filePath, fileModified: new Date(), fileSize: BODY_SIZE, missingSince: opts.missingSince },
    });
    if (opts.onDisk !== false) {
        const full = path.join(MUSIC, filePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, Buffer.alloc(BODY_SIZE, 0xaa));
    }
    return `${P}_${id}`;
}

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

beforeAll(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.mkdirSync(MUSIC, { recursive: true });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
    await prisma.artist.create({ data: { id: `${P}_art`, name: `${P} artist`, identityKey: `${P}_ik` } });
    await prisma.album.create({
        data: { id: `${P}_alb`, rgMbid: `${P}_rg`, artistId: `${P}_art`, title: `${P} album`, primaryType: 'Album', location: 'LIBRARY' },
    });
});

afterAll(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
});

beforeEach(() => {
    (getAudioStreamingService as jest.Mock).mockReset().mockReturnValue(fakeStreamingService());
});

describe('GET /tracks/:id/stream -- no per-user eviction', () => {
    it('two concurrent stream requests for the same user both complete with full bodies', async () => {
        const id = await seedTrack('conc2', 'Artist/Album/conc2.mp3');
        const [r1, r2] = await Promise.all([
            request(app).get(`/tracks/${id}/stream`),
            request(app).get(`/tracks/${id}/stream`),
        ]);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r1.body).toBeInstanceOf(Buffer);
        expect(r2.body).toBeInstanceOf(Buffer);
        expect(r1.body.length).toBe(BODY_SIZE);
        expect(r2.body.length).toBe(BODY_SIZE);
    });

    it('three concurrent stream requests for the same user all complete -- no eviction', async () => {
        const id = await seedTrack('conc3', 'Artist/Album/conc3.mp3');
        const [r1, r2, r3] = await Promise.all([
            request(app).get(`/tracks/${id}/stream`),
            request(app).get(`/tracks/${id}/stream`),
            request(app).get(`/tracks/${id}/stream`),
        ]);

        for (const r of [r1, r2, r3]) {
            expect(r.status).toBe(200);
            expect(r.body.length).toBe(BODY_SIZE);
        }
    });
});

// A stream request is not a listen: plays are recorded by services/playRecording.ts from what was actually heard.
describe('the stream endpoint records no plays', () => {
    it('writes nothing to Play, however many times a track is streamed', async () => {
        const id = await seedTrack('noplay', 'Artist/Album/noplay.mp3');
        for (let i = 0; i < 3; i++) {
            await request(app).get(`/tracks/${id}/stream`).expect(200);
        }
        expect(await prisma.play.count({ where: { userId: USER } })).toBe(0);
    });

    it('answers 400 for a quality it does not know, before touching the file', async () => {
        // No row and no file: the quality is refused first.
        const res = await request(app).get(`/tracks/${P}_nothing/stream?quality=ultra`);
        expect(res.status).toBe(400);
        const pre = await request(app).post(`/tracks/${P}_nothing/prewarm?quality=ultra`);
        expect(pre.status).toBe(400);
        expect(getAudioStreamingService).not.toHaveBeenCalled();
    });
});

// A track the scan flagged missing is not streamable: it answers not-found instead of failing on the file open.
describe('a file gone from disk before a scan has flagged it', () => {
    it('is not available, not a server error', async () => {
        const id = await seedTrack('gone1', 'Artist/Album/gone1.mp3', { onDisk: false });
        const res = await request(app).get(`/tracks/${id}/stream`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Track not available');
    });

    it('is not available when the fallback to the original finds it gone too', async () => {
        expectLog('warn');
        const id = await seedTrack('gone2', 'Artist/Album/gone2.mp3', { onDisk: false });
        const noFfmpeg = Object.assign(new Error('no ffmpeg'), { code: 'FFMPEG_NOT_FOUND' });
        const service = fakeStreamingService();
        const real = service.getStreamFilePath;
        // The transcode attempt fails for want of ffmpeg; the retry at original reaches the real stat.
        service.getStreamFilePath = jest.fn().mockRejectedValueOnce(noFfmpeg).mockImplementation(real);
        (getAudioStreamingService as jest.Mock).mockReturnValue(service);

        const res = await request(app).get(`/tracks/${id}/stream?quality=low`);
        expect(res.status).toBe(404);
        expect(service.getStreamFilePath).toHaveBeenCalledTimes(2);
    });

    it('stays a server error for anything else', async () => {
        expectLog('error');
        const id = await seedTrack('denied', 'Artist/Album/denied.mp3');
        (getAudioStreamingService as jest.Mock).mockReturnValue(fakeStreamingService({
            getStreamFilePath: jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'EACCES' })),
        }));
        const res = await request(app).get(`/tracks/${id}/stream`);
        expect(res.status).toBe(500);
    });
});

describe('a track flagged missing from disk', () => {
    it('gets a clear not-found, not a 500 from the failed open', async () => {
        const id = await seedTrack('flagged1', 'Artist/Album/flagged1.mp3', { onDisk: false, missingSince: new Date('2026-09-25T12:00:00Z') });
        const res = await request(app).get(`/tracks/${id}/stream`);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Track not available');
        // The streaming service was never asked for a file that is not there.
        expect(getAudioStreamingService).not.toHaveBeenCalled();
    });

    it('is not prewarmed either -- prewarming pumps a file that does not exist', async () => {
        const id = await seedTrack('flagged2', 'Artist/Album/flagged2.mp3', { onDisk: false, missingSince: new Date('2026-09-25T12:00:00Z') });
        const res = await request(app).post(`/tracks/${id}/prewarm`);
        expect(res.status).toBe(202);
        expect(getAudioStreamingService).not.toHaveBeenCalled();
    });
});

describe('a track flagged corrupt', () => {
    it('is not prewarmed, because the stream refuses it', async () => {
        const id = await seedTrack('corrupt1', 'Artist/Album/corrupt1.mp3');
        await prisma.track.update({ where: { id }, data: { corrupt: true } });
        const res = await request(app).post(`/tracks/${id}/prewarm`);
        expect(res.status).toBe(202);
        expect(getAudioStreamingService).not.toHaveBeenCalled();
    });
});
