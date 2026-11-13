/**
 * scrobble.view records a play, through the real route, real recordPlay and real liveListening.
 * Real database; the public live user is found by username.
 */

import express from 'express';
import request from 'supertest';
import { ListenSource } from '@prisma/client';
import { playbackRouter } from '../playback';
import { prisma } from '../../../utils/db';
import { config } from '../../../config';
import { getLiveState, reportLive, resetLive } from '../../../services/liveListening';

const P = 'zz-scrobble';
const USER = `${P}-user`;
const TRACK = `${P}-track`;

function makeApp() {
    const app = express();
    app.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: 'user' };
        next();
    });
    app.use('/rest', playbackRouter);
    return app;
}

const plays = () => prisma.play.findMany({ where: { userId: USER, trackId: TRACK } });

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: 'x' } });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    await prisma.album.create({
        data: { id: `${P}-al`, rgMbid: `${P}-rg`, artistId: `${P}-ar`, identityKey: `${P}-al`, title: P, primaryType: 'Album', location: 'LIBRARY' },
    });
    await prisma.track.create({
        data: { id: TRACK, albumId: `${P}-al`, title: P, trackNo: 1, duration: 200, filePath: `${P}.flac`, fileModified: new Date(), fileSize: 1 },
    });
});

afterAll(async () => {
    resetLive();
    await prisma.play.deleteMany({ where: { userId: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

beforeEach(async () => {
    await prisma.play.deleteMany({ where: { userId: USER } });
});

describe('scrobble.view records plays', () => {
    const app = makeApp();

    it('writes a SUBSONIC play for submission=true, at the client timestamp', async () => {
        const res = await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=true&time=1700000000000`);
        expect(res.status).toBe(200);
        const rows = await plays();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ source: ListenSource.SUBSONIC, playedAt: new Date(1700000000000) });
    });

    it('records a play stamped in the future as played now, never ahead of the clock', async () => {
        const before = Date.now();
        const res = await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=true&time=${before + 86_400_000}`);
        expect(res.status).toBe(200);
        const rows = await plays();
        expect(rows).toHaveLength(1);
        expect(rows[0].playedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(rows[0].playedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('writes nothing for a now-playing notification (submission=false)', async () => {
        const res = await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=false`);
        expect(res.status).toBe(200);
        expect(await plays()).toHaveLength(0);
    });

    it('keeps the dedupe: a repeat inside the window writes nothing', async () => {
        await prisma.play.create({ data: { userId: USER, trackId: TRACK, playedAt: new Date() } });
        const res = await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=true`);
        expect(res.status).toBe(200);
        expect(await plays()).toHaveLength(1);
    });
});

describe('scrobble.view now-playing and the public live trip', () => {
    const app = makeApp();
    const original = config.publicVibe;

    beforeEach(() => {
        // Forgets the cached public user and any earlier report.
        resetLive();
        config.publicVibe = { token: 'x'.repeat(32), username: USER };
    });

    afterAll(() => {
        config.publicVibe = original;
    });

    it('starts the trip at the top of the track for the public user', async () => {
        await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=false`);
        // A playing track's position runs on with the clock, so a few milliseconds past the top still counts.
        const live = getLiveState();
        expect(live).toMatchObject({ status: 'playing', trackId: TRACK, duration: 200_000, queue: [] });
        expect(live.position).toBeLessThan(1000);
        expect(await plays()).toHaveLength(0);
    });

    it('keeps the position when the same track is announced again', async () => {
        await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=false`);
        // Pause at 42 s, then the client announces the track again.
        reportLive({ status: 'paused', trackId: TRACK, position: 42_000, duration: 200_000, queue: [] });
        await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=false`);
        const live = getLiveState();
        expect(live).toMatchObject({ status: 'playing', trackId: TRACK, duration: 200_000, queue: [] });
        expect(live.position).toBeGreaterThanOrEqual(42_000);
        expect(live.position).toBeLessThan(43_000);
    });

    it('reports nothing when the public routes are off', async () => {
        config.publicVibe = null;
        await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=false`);
        expect(getLiveState().trackId).toBeNull();
    });

    it('reports nothing for a completed play', async () => {
        await request(app).get(`/rest/scrobble.view?id=${TRACK}&submission=true`);
        expect(getLiveState().trackId).toBeNull();
    });
});
