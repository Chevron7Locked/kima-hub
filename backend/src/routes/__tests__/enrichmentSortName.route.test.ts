/**
 * The artist and album metadata override and reset handlers keep `sortName` in
 * step with displayName / displayTitle. They are its only writers, and every
 * listing orders on it. Real router, real admin token and database.
 */

import express from 'express';
import request from 'supertest';
import router from '../enrichment';
import { prisma } from '../../utils/db';
import { generateToken } from '../../middleware/auth';
import { closeEngineConnections } from '../../__tests__/helpers/engineConnections';
import { mountAsServer } from "./helpers/serverMount";

const P = 'esn_';
const ADMIN = `${P}admin`;
const ARTIST = `${P}art`;
const ALBUM = `${P}alb`;
const SENTINEL = 'zz sentinel';

const app = express();
app.use(express.json());
mountAsServer(app, '/enrichment', router, "/api/enrichment");
const asAdmin = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: 'admin', tokenVersion: 0 })}`;
const put = (path: string) => request(app).put(path).set('Authorization', asAdmin);
const post = (path: string) => request(app).post(path).set('Authorization', asAdmin);

// An artist and an album carrying an earlier edit, filed under a sortName that is neither name.
async function seed(artistName: string, albumTitle: string) {
    await prisma.album.deleteMany({ where: { id: ALBUM } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.artist.create({
        data: { id: ARTIST, name: artistName, normalizedName: artistName.toLowerCase(), identityKey: `${P}ik`, displayName: 'Earlier Edit', sortName: SENTINEL, hasUserOverrides: true },
    });
    await prisma.album.create({
        data: {
            id: ALBUM, rgMbid: `${P}rg`, artistId: ARTIST, identityKey: `${P}ak`, title: albumTitle, primaryType: 'Album', location: 'LIBRARY',
            displayTitle: 'Earlier Edit', sortName: SENTINEL, hasUserOverrides: true,
        },
    });
}
const artistRow = () => prisma.artist.findUniqueOrThrow({ where: { id: ARTIST } });
const albumRow = () => prisma.album.findUniqueOrThrow({ where: { id: ALBUM } });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: 'x', role: 'admin', tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.album.deleteMany({ where: { id: ALBUM } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe('PUT /enrichment/artists/:id/metadata -- sortName follows displayName', () => {
    it('sets sortName from the override, article-stripped, not from the canonical name', async () => {
        await seed('Canonical Name', 'x');

        const res = await put(`/enrichment/artists/${ARTIST}/metadata`)
            .send({ name: 'The Artist Formerly Known As Prince' })
            .expect(200);

        expect(res.body).toMatchObject({ displayName: 'The Artist Formerly Known As Prince', sortName: 'artist formerly known as prince' });
        expect(await artistRow()).toMatchObject({
            displayName: 'The Artist Formerly Known As Prince',
            sortName: 'artist formerly known as prince',
            name: 'Canonical Name',
        });
    });

    it('reverts sortName to the canonical name when the override is cleared to an empty string', async () => {
        await seed('The Beatles', 'x');

        await put(`/enrichment/artists/${ARTIST}/metadata`).send({ name: '' }).expect(200);

        expect(await artistRow()).toMatchObject({ displayName: '', sortName: 'beatles' });
    });

    it('reverts sortName to the canonical name when the override is cleared to null', async () => {
        await seed('Los Lobos', 'x');

        await put(`/enrichment/artists/${ARTIST}/metadata`).send({ name: null }).expect(200);

        expect(await artistRow()).toMatchObject({ displayName: null, sortName: 'lobos' });
    });

    it('does not touch sortName at all when name is not part of the request', async () => {
        await seed('The Beatles', 'x');

        await put(`/enrichment/artists/${ARTIST}/metadata`).send({ bio: 'Some bio text' }).expect(200);

        expect(await artistRow()).toMatchObject({ userSummary: 'Some bio text', displayName: 'Earlier Edit', sortName: SENTINEL });
    });
});

describe('POST /enrichment/artists/:id/reset -- sortName follows the cleared override', () => {
    it('resets sortName to the canonical name alongside displayName', async () => {
        await seed('The Beatles', 'x');

        await post(`/enrichment/artists/${ARTIST}/reset`).expect(200);

        expect(await artistRow()).toMatchObject({ displayName: null, sortName: 'beatles', hasUserOverrides: false });
    });

    it('404s without touching sortName when the artist does not exist', async () => {
        await seed('The Beatles', 'x');

        await post(`/enrichment/artists/${P}missing/reset`).expect(404);

        expect(await artistRow()).toMatchObject({ displayName: 'Earlier Edit', sortName: SENTINEL });
    });
});

describe('PUT /enrichment/albums/:id/metadata -- sortName follows displayTitle', () => {
    it('sets sortName from the override, article-stripped, not from the canonical title', async () => {
        await seed('Artist', 'Canonical Title');

        const res = await put(`/enrichment/albums/${ALBUM}/metadata`)
            .send({ title: 'The Dark Side of the Moon' })
            .expect(200);

        expect(res.body).toMatchObject({ displayTitle: 'The Dark Side of the Moon', sortName: 'dark side of the moon' });
        expect(await albumRow()).toMatchObject({
            displayTitle: 'The Dark Side of the Moon',
            sortName: 'dark side of the moon',
            title: 'Canonical Title',
        });
    });

    it('reverts sortName to the canonical title when the override is cleared to an empty string', async () => {
        await seed('Artist', 'Los Angeles');

        await put(`/enrichment/albums/${ALBUM}/metadata`).send({ title: '' }).expect(200);

        expect(await albumRow()).toMatchObject({ displayTitle: '', sortName: 'angeles' });
    });

    it('reverts sortName to the canonical title when the override is cleared to null', async () => {
        await seed('Artist', 'Le Bootleg');

        await put(`/enrichment/albums/${ALBUM}/metadata`).send({ title: null }).expect(200);

        expect(await albumRow()).toMatchObject({ displayTitle: null, sortName: 'bootleg' });
    });

    it('does not touch sortName at all when title is not part of the request', async () => {
        await seed('Artist', 'The Dark Side of the Moon');

        await put(`/enrichment/albums/${ALBUM}/metadata`).send({ year: '1973' }).expect(200);

        expect(await albumRow()).toMatchObject({ displayYear: 1973, displayTitle: 'Earlier Edit', sortName: SENTINEL });
    });
});

describe('POST /enrichment/albums/:id/reset -- sortName follows the cleared override', () => {
    it('resets sortName to the canonical title alongside displayTitle', async () => {
        await seed('Artist', 'The Dark Side of the Moon');

        await post(`/enrichment/albums/${ALBUM}/reset`).expect(200);

        expect(await albumRow()).toMatchObject({ displayTitle: null, sortName: 'dark side of the moon', hasUserOverrides: false });
    });

    it('404s without touching sortName when the album does not exist', async () => {
        await seed('Artist', 'The Dark Side of the Moon');

        await post(`/enrichment/albums/${P}missing/reset`).expect(404);

        expect(await albumRow()).toMatchObject({ displayTitle: 'Earlier Edit', sortName: SENTINEL });
    });
});
