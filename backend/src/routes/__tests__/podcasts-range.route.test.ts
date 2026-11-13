// Real router and database. Range handling on cached podcast files: unsatisfiable → 416 with
// Content-Range, multi-range → 200 full body, valid → 206 slice. An episode not
// cached yet is streamed from its host with the size the host states.

// Dynamic import of podcastDownload inside the route handler -- mock it.
jest.mock('../../services/podcastDownload', () => ({
    getCachedFilePath: jest.fn(),
    downloadInBackground: jest.fn(),
    isDownloading: jest.fn().mockReturnValue(false),
}));

jest.mock('../../middleware/auth', () => require('./helpers/podcastRoute').podcastAuthMock('user-123'));

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
import { mountAsServer } from "./helpers/serverMount";

const SHOW = 'pod_range_show';
const EP = 'pod_range_ep';
const URL_PATH = `/podcasts/${SHOW}/episodes/${EP}/stream`;

// The episode row, replaced in beforeAll/beforeEach as each case needs it.
async function seedEpisode(fields: { audioUrl: string; fileSize: number | null }) {
    await prisma.podcastEpisode.deleteMany({ where: { id: EP } });
    await prisma.podcastEpisode.create({
        data: { id: EP, podcastId: SHOW, guid: 'g', title: 'Episode 1', publishedAt: new Date(Date.UTC(2026, 9, 1)), mimeType: 'audio/mpeg', ...fields },
    });
}

beforeAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: SHOW } });
    await prisma.podcast.create({ data: { id: SHOW, feedUrl: 'https://f.invalid/range', title: 'Range Show' } });
});

afterAll(async () => {
    await prisma.podcast.deleteMany({ where: { id: SHOW } });
});

function makeApp() {
    const app = express();
    app.use(express.json());
    mountAsServer(app, '/podcasts', podcastRoutes, "/api/podcasts");
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

    beforeEach(async () => {
        jest.clearAllMocks();
        await seedEpisode({ audioUrl: 'http://example.com/ep1.mp3', fileSize: null });
        (podcastDownload.getCachedFilePath as jest.Mock).mockResolvedValue(tmpFile);
    });

    it('valid range -> 206 with the correct slice', async () => {
        const res = await request(app)
            .get(URL_PATH)
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

    it('an episode asked for under another show -> 404, nothing served', async () => {
        const res = await request(app).get(`/podcasts/some_other_show/episodes/${EP}/stream`);

        expect(res.status).toBe(404);
    });

    it('out-of-range -> 416 with Content-Range: bytes */<size>', async () => {
        const res = await request(app)
            .get(URL_PATH)
            .set('Range', `bytes=${FILE_SIZE + 100}-${FILE_SIZE + 200}`);

        expect(res.status).toBe(416);
        expect(res.headers['content-range']).toBe(`bytes */${FILE_SIZE}`);
    });

    it('multi-range -> 200 with full body', async () => {
        const res = await request(app)
            .get(URL_PATH)
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

    beforeEach(async () => {
        jest.clearAllMocks();
        seen = [];
        const { port } = host.address() as AddressInfo;
        await seedEpisode({ audioUrl: `http://127.0.0.1:${port}/ep1.mp3`, fileSize: FEED_DECLARED });
        (podcastDownload.getCachedFilePath as jest.Mock).mockResolvedValue(null);
    });

    const stream = (range?: string) => {
        const req = request(app).get(URL_PATH).buffer(true).parse((res, done) => {
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
        expect(podcastDownload.downloadInBackground).toHaveBeenCalledWith(EP, expect.stringContaining('/ep1.mp3'), 'user-123');
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
