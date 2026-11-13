/**
 * requireAuth, requireAdmin and requireAuthOrToken, branch by branch, against the
 * real database; JWTs are really signed with the test secret from test-env.cjs.
 */

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

jest.mock('../../utils/logger', () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
    },
}));

import {
    requireAuth,
    requireAdmin,
    requireAuthOrToken,
    clearUserCache,
    invalidateUserCache,
} from '../../middleware/auth';
import { prisma } from '../../utils/db';

const TEST_SECRET = process.env.JWT_SECRET!;

const P = 'zz-auth-';
const USER = `${P}user`;
const ADMIN = `${P}admin`;

async function wipe() {
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

/** The two accounts the tokens below are signed for. */
const seedUsers = () =>
    prisma.user.createMany({
        data: [
            { id: USER, username: USER, passwordHash: 'x', role: 'user', tokenVersion: 1 },
            { id: ADMIN, username: ADMIN, passwordHash: 'x', role: 'admin', tokenVersion: 1 },
        ],
    });

beforeAll(wipe);
afterAll(wipe);
beforeEach(async () => {
    await wipe();
    await seedUsers();
    // The auth layer caches the user row across requests; without this the
    // previous test's user leaks into this one.
    clearUserCache();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
    return {
        headers: {},
        query: {},
        session: {},
        // Express always populates `path`; the query-token branch reads it to
        // decide whether a stream-scoped ticket is on a stream route. Omitting
        // it here made that branch throw into a swallowed catch and report a
        // silent auth failure.
        path: '/api/library/albums',
        ...overrides,
    } as unknown as Request;
}

function mockRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
    const json = jest.fn().mockReturnThis();
    const status = jest.fn().mockReturnValue({ json });
    return { res: { status } as unknown as Response, status, json };
}

function mockNext(): NextFunction {
    return jest.fn();
}

function validToken(
    userId = USER,
    tokenVersion = 1,
    role = 'user'
): string {
    return jwt.sign(
        { userId, username: 'testuser', role, tokenVersion },
        TEST_SECRET,
        { expiresIn: '24h' }
    );
}

function expiredToken(userId = USER, tokenVersion = 1): string {
    // expiresIn: 1 (one second): expired by the time the test uses it
    return jwt.sign(
        { userId, username: 'testuser', role: 'user', tokenVersion },
        TEST_SECRET,
        { expiresIn: 1 }
    );
}

// ── requireAuth ───────────────────────────────────────────────────────────────

describe('requireAuth', () => {
    it('returns 401 when no Authorization header is present', async () => {
        const req = mockReq();
        const { res, status, json } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(json).toHaveBeenCalledWith({ error: 'Not authenticated' });
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when Authorization uses Basic scheme instead of Bearer', async () => {
        const req = mockReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } });
        const { res, status, json } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(json).toHaveBeenCalledWith({ error: 'Not authenticated' });
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when Bearer token is empty string', async () => {
        const req = mockReq({ headers: { authorization: 'Bearer ' } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when JWT is expired', async () => {
        const token = expiredToken(USER, 1);
        // Wait for the 1-second token to expire
        await new Promise(r => setTimeout(r, 1100));
        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when tokenVersion in token does not match DB (password was changed)', async () => {
        // Token has tokenVersion: 1, DB has tokenVersion: 2 (password was changed)
        const staleToken = validToken(USER, 1);
        await prisma.user.update({ where: { id: USER }, data: { tokenVersion: 2 } }); // incremented when password changed

        const req = mockReq({ headers: { authorization: `Bearer ${staleToken}` } });
        const { res, status, json } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(json).toHaveBeenCalledWith({ error: 'Not authenticated' });
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when token has no tokenVersion claim (legacy token format)', async () => {
        // A token without a tokenVersion claim
        const legacyToken = jwt.sign(
            { userId: USER, username: 'testuser', role: 'user' }, // no tokenVersion
            TEST_SECRET,
            { expiresIn: '24h' }
        );

        const req = mockReq({ headers: { authorization: `Bearer ${legacyToken}` } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        // tokenVersion === undefined in token !== 1 in DB -> must reject
        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when JWT userId does not exist in DB', async () => {
        const token = validToken('deleted-user-id'); // no such user

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next and sets req.user when token and tokenVersion are valid', async () => {
        const token = validToken(USER, 1);

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({ id: USER, username: USER, role: 'user' });
    });

    it('req.user does not contain tokenVersion or passwordHash (no sensitive data leaked into request context)', async () => {
        const token = validToken(USER, 1);

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res } = mockRes();
        await requireAuth(req, res, mockNext());

        expect(req.user).not.toHaveProperty('tokenVersion');
        expect(req.user).not.toHaveProperty('passwordHash');
    });
});

// ── requireAdmin ──────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
    it('returns 403 when authenticated user has role "user"', async () => {
        const token = validToken(USER, 1, 'user');

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res, status, json } = mockRes();
        const next = mockNext();

        await requireAdmin(req, res, next);

        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith({ error: 'Admin access required' });
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next when authenticated user has role "admin"', async () => {
        const adminToken = validToken(ADMIN, 1, 'admin');

        const req = mockReq({ headers: { authorization: `Bearer ${adminToken}` } });
        const { res } = mockRes();
        const next = mockNext();

        await requireAdmin(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user?.role).toBe('admin');
    });

    it('returns 401 (not 403) when no token provided -- unauthenticated vs unauthorized are distinct', async () => {
        const req = mockReq();
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAdmin(req, res, next);

        // Must be 401 (not authenticated), not 403 (authenticated but wrong role)
        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });
});

// ── requireAuthOrToken (streaming / query-param auth) ─────────────────────────

describe('requireAuthOrToken', () => {
    it('authenticates via token query param when no Authorization header present', async () => {
        const token = validToken(USER, 1);

        const req = mockReq({ query: { token } });
        const { res } = mockRes();
        const next = mockNext();

        await requireAuthOrToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user?.id).toBe(USER);
    });

    it('returns 401 for query token with mismatched tokenVersion (revoked streaming URL)', async () => {
        // Streaming URLs with embedded tokens are long-lived -- tokenVersion check
        // prevents a stolen URL from working after a password change
        const staleToken = validToken(USER, 1);
        await prisma.user.update({ where: { id: USER }, data: { tokenVersion: 2 } });

        const req = mockReq({ query: { token: staleToken } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuthOrToken(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    describe('stream-scoped tickets', () => {
        const ticket = () => jwt.sign(
            { userId: USER, username: 'testuser', role: 'user', tokenVersion: 1, scope: 'stream' },
            TEST_SECRET,
            { expiresIn: '5m' }
        );

        it.each([
            '/tracks/t1/stream',
            '/preview/123456/snippet',
        ])('accepts a ticket on the audio route %s', async (path) => {
            const req = mockReq({ path, query: { token: ticket() } });
            const { res } = mockRes();
            const next = mockNext();

            await requireAuthOrToken(req, res, next);

            expect(next).toHaveBeenCalledTimes(1);
            expect(req.user?.id).toBe(USER);
        });

        it.each([
            '/preview/123456',
            '/preview/123456/similar',
            '/preview/123456/snippet/extra',
            '/snippet',
            '/preview/a/b/snippet',
        ])('refuses a ticket on the non-audio route %s', async (path) => {
            const req = mockReq({ path, query: { token: ticket() } });
            const { res, status } = mockRes();
            const next = mockNext();

            await requireAuthOrToken(req, res, next);

            expect(status).toHaveBeenCalledWith(401);
            expect(next).not.toHaveBeenCalled();
        });
    });
});

// ── user cache ────────────────────────────────────────────────────────────────

describe('user row cache', () => {
    it('serves repeated requests from the cache: the account can vanish and the token still passes', async () => {
        const token = validToken(USER, 1);
        const results: boolean[] = [];

        for (let i = 0; i < 5; i += 1) {
            const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
            const { res } = mockRes();
            const next = mockNext();
            await requireAuth(req, res, next);
            results.push((next as jest.Mock).mock.calls.length === 1);
            // After the first request has read the row, it is gone from the database.
            if (i === 0) await prisma.user.delete({ where: { id: USER } });
        }

        expect(results).toEqual([true, true, true, true, true]);
    });

    it('requireAdmin reuses an already-authenticated request', async () => {
        const token = validToken(ADMIN, 1, 'admin');

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res } = mockRes();
        const next = mockNext();

        // The real chain: app.use(path, requireAuth, requireAdmin, ...)
        await requireAuth(req, res, next);
        clearUserCache(); // prove the reuse, not the cache
        await prisma.user.delete({ where: { id: ADMIN } }); // nothing to read a second time
        await requireAdmin(req, res, next);

        expect(next).toHaveBeenCalledTimes(2);
    });

    it('revocation takes effect immediately once the cache is invalidated', async () => {
        const token = validToken(USER, 1);

        const first = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const r1 = mockRes();
        const n1 = mockNext();
        await requireAuth(first, r1.res, n1);
        expect(n1).toHaveBeenCalledTimes(1);

        // Password changed: tokenVersion bumped, and the route invalidates.
        await prisma.user.update({ where: { id: USER }, data: { tokenVersion: 2 } });
        invalidateUserCache(USER);

        const second = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const r2 = mockRes();
        const n2 = mockNext();
        await requireAuth(second, r2.res, n2);

        expect(r2.status).toHaveBeenCalledWith(401);
        expect(n2).not.toHaveBeenCalled();
    });

    it('caches a missing user so a bad token cannot hammer the database', async () => {
        const token = validToken(`${P}ghost`, 1);
        const statuses: number[] = [];

        for (let i = 0; i < 4; i += 1) {
            const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
            const { res, status } = mockRes();
            await requireAuth(req, res, mockNext());
            statuses.push(status.mock.calls[0][0]);
            // The account appears after the first miss: the cached miss still answers.
            if (i === 0) {
                await prisma.user.create({ data: { id: `${P}ghost`, username: `${P}late`, passwordHash: 'x', tokenVersion: 1 } });
            }
        }

        expect(statuses).toEqual([401, 401, 401, 401]);
        await prisma.user.delete({ where: { id: `${P}ghost` } });
    });
});
