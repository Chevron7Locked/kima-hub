jest.mock('../../middleware/subsonicAuth', () => ({
    subsonicAuth: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock('../../utils/db', () => ({
    prisma: {
        apiKey: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('../../workers/queues', () => ({
    scanQueue: {
        getJobCounts: jest.fn(),
        add: jest.fn(),
    },
}));

jest.mock('../../config', () => ({
    config: {
        music: { musicPath: '/music' },
    },
}));

jest.mock('../subsonic/compat', () => ({ compatRouter: require('express').Router() }));
jest.mock('../subsonic/library', () => ({ libraryRouter: require('express').Router() }));
jest.mock('../subsonic/playback', () => ({ playbackRouter: require('express').Router() }));
jest.mock('../subsonic/search', () => ({ searchRouter: require('express').Router() }));
jest.mock('../subsonic/playlists', () => ({ playlistRouter: require('express').Router() }));
jest.mock('../subsonic/queue', () => ({ queueRouter: require('express').Router() }));
jest.mock('../subsonic/starred', () => ({ starredRouter: require('express').Router() }));
jest.mock('../subsonic/artistInfo', () => ({ artistInfoRouter: require('express').Router() }));
jest.mock('../subsonic/lyrics', () => ({ lyricsRouter: require('express').Router() }));
jest.mock('../subsonic/userManagement', () => ({ userManagementRouter: require('express').Router() }));
jest.mock('../subsonic/profile', () => ({ profileRouter: require('express').Router() }));
jest.mock('../subsonic/podcasts', () => ({ podcastRouter: require('express').Router() }));

import express from 'express';
import request from 'supertest';
import { subsonicRouter } from '../subsonic';

describe('Subsonic extension advertisement', () => {
    function makeApp() {
        const app = express();
        app.use('/rest', subsonicRouter);
        return app;
    }

    it('getOpenSubsonicExtensions advertises songLyrics versions 1 and 2', async () => {
        const app = makeApp();

        const res = await request(app)
            .get('/rest/getOpenSubsonicExtensions.view')
            .query({ f: 'json' });

        expect(res.status).toBe(200);
        expect(res.body['subsonic-response'].status).toBe('ok');

        const extensions = res.body['subsonic-response'].openSubsonicExtensions;
        const songLyrics = extensions.find((ext: any) => ext.name === 'songLyrics');

        expect(songLyrics).toBeDefined();
        expect(songLyrics.versions).toEqual([1, 2]);
    });

    it('getOpenSubsonicExtensions emits name as XML attribute for Amperfy parser compatibility', async () => {
        const app = makeApp();

        const res = await request(app)
            .get('/rest/getOpenSubsonicExtensions.view');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('text/xml');
        // name must be an XML attribute, not a child element
        expect(res.text).toContain('<openSubsonicExtensions name="songLyrics">');
        expect(res.text).not.toContain('<name>songLyrics</name>');
    });
});
