import { apiLimiter, createRateLimiter, trustOneProxyHop } from '../rateLimiter';
import express from 'express';
import request from 'supertest';

// express-rate-limit does not expose its options, so the skip behaviour is
// checked through a throwaway express app: a skipped request carries no RateLimit-* headers.
function makeSkipApp() {
    const app = express();
    app.use(apiLimiter);
    app.get('*', (_req, res) => res.status(200).json({ ok: true }));
    return app;
}

describe('apiLimiter skip predicate', () => {
    let app: express.Application;

    beforeAll(() => { app = makeSkipApp(); });

    it('skips a podcast stream URL that includes a ?token= query string', async () => {
        const res = await request(app)
            .get('/api/podcasts/p1/episodes/e1/stream?token=eyJhbGci')
            .expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    });

    it('skips a track stream URL', async () => {
        const res = await request(app)
            .get('/api/library/tracks/track-123/stream?token=abc')
            .expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    });

    it('skips the health endpoint', async () => {
        const res = await request(app).get('/health').expect(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
    });

    it('does not skip a non-stream podcast path', async () => {
        const res = await request(app)
            .get('/api/podcasts/p1/episodes?token=abc')
            .expect(200);
        expect(res.headers['ratelimit-limit']).toBeDefined();
    });
});

describe('the proxy setting', () => {
    async function warningsFor(setUp: (app: express.Express) => void) {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
        const app = express();
        setUp(app);
        app.use(createRateLimiter({ windowMs: 60 * 1000, max: 10 }));
        app.get('*', (_req, res) => res.status(200).json({ ok: true }));

        await request(app).get('/rest/ping.view').set('X-Forwarded-For', '203.0.113.9').expect(200);

        const warned = errors.mock.calls.flat().some((a) => (a as { code?: string })?.code === 'ERR_ERL_PERMISSIVE_TRUST_PROXY');
        errors.mockRestore();
        return warned;
    }

    it('lets the limiter\'s own warning speak: trusting every hop raises it', async () => {
        expect(await warningsFor((app) => app.set('trust proxy', true))).toBe(true);
    });

    it('raises no warning with the production setting, one trusted hop', async () => {
        expect(await warningsFor((app) => trustOneProxyHop(app))).toBe(false);
    });
});
