// Range handling on cached podcast files: unsatisfiable → 416 with
// Content-Range, multi-range → 200 full body, valid → 206 slice. An episode not
// cached yet is streamed from its host with the size the host states.

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
import http from 'http';
import type { AddressInfo } from 'net';
import { USER_AGENT } from '../../config';

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

describe('cached-path range policy', () => {
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

// ── Uncached: streamed from the host ──────────────────────────────────────────

describe('uncached stream from the host', () => {
    // Behaves as Acast was measured to: each identity gets its own stitched copy, and neither matches
    // the length the feed declares. Kima's own identity gets the copy the background download caches.
    const KIMA_COPY = Buffer.from(Array.from({ length: 6000 }, (_, i) => i & 0xff));
    const OTHER_COPY = Buffer.from(Array.from({ length: 3500 }, (_, i) => (i * 7) & 0xff));
    const FEED_DECLARED = 9999;
    let host: http.Server;
    let seen: Array<{ agent?: string; range?: string }> = [];
    let app: express.Application;

    beforeAll(async () => {
        host = http.createServer((req, res) => {
            seen.push({ agent: req.headers['user-agent'], range: req.headers.range });
            const body = req.headers['user-agent']?.startsWith('Kima/') ? KIMA_COPY : OTHER_COPY;
            const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
            if (!m) {
                res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': body.length });
                return res.end(body);
            }
            const start = m[1] ? Number(m[1]) : body.length - Number(m[2]);
            const end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
            if (start >= body.length) {
                res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
                return res.end();
            }
            res.writeHead(206, {
                'Content-Type': 'audio/mpeg',
                'Content-Range': `bytes ${start}-${end}/${body.length}`,
                'Content-Length': end - start + 1,
            });
            res.end(body.subarray(start, end + 1));
        });
        await new Promise<void>((ok) => host.listen(0, '127.0.0.1', () => ok()));
        app = makeApp();
    });

    afterAll(() => new Promise<void>((ok) => host.close(() => ok())));

    beforeEach(() => {
        jest.clearAllMocks();
        seen = [];
        const { port } = host.address() as AddressInfo;
        (prisma.podcastEpisode.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_EPISODE,
            audioUrl: `http://127.0.0.1:${port}/ep1.mp3`,
            fileSize: FEED_DECLARED,
        });
        (podcastDownload.getCachedFilePath as jest.Mock).mockResolvedValue(null);
    });

    const stream = (range?: string) => {
        const req = request(app).get('/podcasts/pod-1/episodes/ep-1/stream').buffer(true).parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => done(null, Buffer.concat(chunks)));
        });
        return range ? req.set('Range', range) : req;
    };

    it("tells the browser the size of the copy the host sends, not the feed's declared length", async () => {
        const res = await stream('bytes=0-');
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe(`bytes 0-5999/${KIMA_COPY.length}`);
        expect(Number(res.headers['content-length'])).toBe(KIMA_COPY.length);
        expect(Buffer.compare(res.body, KIMA_COPY)).toBe(0);
    });

    it('asks the host as Kima, like the background download, so the copy played is the copy cached', async () => {
        await stream('bytes=1000-1999');
        expect(seen).toEqual([{ agent: USER_AGENT, range: 'bytes=1000-1999' }]);
        expect(podcastDownload.downloadInBackground).toHaveBeenCalledWith('ep-1', expect.stringContaining('/ep1.mp3'), 'user-123');
    });

    it('passes a slice and its place in the whole copy through', async () => {
        const res = await stream('bytes=1000-1999');
        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe(`bytes 1000-1999/${KIMA_COPY.length}`);
        expect(Buffer.compare(res.body, KIMA_COPY.subarray(1000, 2000))).toBe(0);
    });

    it('answers a range past the end with the host\'s 416 and its real size', async () => {
        const res = await stream('bytes=7000-');
        expect(res.status).toBe(416);
        expect(res.headers['content-range']).toBe(`bytes */${KIMA_COPY.length}`);
    });

    it('streams the whole copy with its real length when no range or several ranges are asked', async () => {
        for (const range of [undefined, 'bytes=0-10,20-30']) {
            seen = [];
            const res = await stream(range);
            expect(res.status).toBe(200);
            expect(Number(res.headers['content-length'])).toBe(KIMA_COPY.length);
            expect(Buffer.compare(res.body, KIMA_COPY)).toBe(0);
            expect(seen).toEqual([{ agent: USER_AGENT, range: undefined }]);
        }
    });
});
