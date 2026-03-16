/**
 * Auth Middleware Tests
 *
 * Tests the three exported middleware functions: requireAuth, requireAdmin,
 * requireAuthOrToken. Each test targets a specific code branch and asserts
 * on an observable outcome (status code, response body, req.user state,
 * next() called or not).
 *
 * No database is hit -- prisma.user.findUnique and prisma.apiKey.findUnique
 * are mocked. Real JWT signing/verification is used against the test secret
 * set in src/__mocks__/test-env.cjs.
 */

import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

// Must be declared before auth import -- jest.mock is hoisted
jest.mock('../../utils/db', () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
        },
        apiKey: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
    },
}));

import { requireAuth, requireAdmin, requireAuthOrToken } from '../../middleware/auth';
import { prisma } from '../../utils/db';

const TEST_SECRET = process.env.JWT_SECRET!;

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
    return {
        headers: {},
        query: {},
        session: {},
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
    userId = 'user-123',
    tokenVersion = 1,
    role = 'user'
): string {
    return jwt.sign(
        { userId, username: 'testuser', role, tokenVersion },
        TEST_SECRET,
        { expiresIn: '24h' }
    );
}

function expiredToken(userId = 'user-123', tokenVersion = 1): string {
    // expiresIn: 0 produces an already-expired token
    return jwt.sign(
        { userId, username: 'testuser', role: 'user', tokenVersion },
        TEST_SECRET,
        { expiresIn: 1 }
    );
}

const DB_USER = { id: 'user-123', username: 'testuser', role: 'user', tokenVersion: 1 };

// ── requireAuth ───────────────────────────────────────────────────────────────

describe('requireAuth', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    });

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
        const { res, status, json } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when JWT is expired', async () => {
        const token = expiredToken('user-123', 1);
        // Wait for the 1-second token to expire
        await new Promise(r => setTimeout(r, 1100));
        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
        // prisma should not be called -- jwt.verify rejects before DB lookup
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('returns 401 when tokenVersion in token does not match DB (password was changed)', async () => {
        // Token has tokenVersion: 1, DB has tokenVersion: 2 (password was changed)
        const staleToken = validToken('user-123', 1);
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            ...DB_USER,
            tokenVersion: 2, // incremented when password changed
        });

        const req = mockReq({ headers: { authorization: `Bearer ${staleToken}` } });
        const { res, status, json } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(json).toHaveBeenCalledWith({ error: 'Not authenticated' });
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when token has no tokenVersion claim (legacy token format)', async () => {
        // Old tokens issued before tokenVersion was added have no tokenVersion claim
        const legacyToken = jwt.sign(
            { userId: 'user-123', username: 'testuser', role: 'user' }, // no tokenVersion
            TEST_SECRET,
            { expiresIn: '24h' }
        );
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(DB_USER);

        const req = mockReq({ headers: { authorization: `Bearer ${legacyToken}` } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        // tokenVersion === undefined in token !== 1 in DB -> must reject
        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when JWT userId does not exist in DB', async () => {
        const token = validToken('deleted-user-id');
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(null); // user deleted

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next and sets req.user when token and tokenVersion are valid', async () => {
        const token = validToken('user-123', 1);
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(DB_USER);

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res } = mockRes();
        const next = mockNext();

        await requireAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({ id: 'user-123', username: 'testuser', role: 'user' });
    });

    it('req.user does not contain tokenVersion or passwordHash (no sensitive data leaked into request context)', async () => {
        const token = validToken('user-123', 1);
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(DB_USER);

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res } = mockRes();
        await requireAuth(req, res, mockNext());

        expect(req.user).not.toHaveProperty('tokenVersion');
        expect(req.user).not.toHaveProperty('passwordHash');
    });
});

// ── requireAdmin ──────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('returns 403 when authenticated user has role "user"', async () => {
        const token = validToken('user-123', 1, 'user');
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(DB_USER);

        const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
        const { res, status, json } = mockRes();
        const next = mockNext();

        await requireAdmin(req, res, next);

        expect(status).toHaveBeenCalledWith(403);
        expect(json).toHaveBeenCalledWith({ error: 'Admin access required' });
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next when authenticated user has role "admin"', async () => {
        const adminToken = validToken('admin-123', 1, 'admin');
        const adminUser = { ...DB_USER, id: 'admin-123', role: 'admin' };
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);

        const req = mockReq({ headers: { authorization: `Bearer ${adminToken}` } });
        const { res } = mockRes();
        const next = mockNext();

        await requireAdmin(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user?.role).toBe('admin');
    });

    it('returns 401 (not 403) when no token provided -- unauthenticated vs unauthorized are distinct', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
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
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(null);
    });

    it('authenticates via token query param when no Authorization header present', async () => {
        const token = validToken('user-123', 1);
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(DB_USER);

        const req = mockReq({ query: { token } });
        const { res } = mockRes();
        const next = mockNext();

        await requireAuthOrToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user?.id).toBe('user-123');
    });

    it('returns 401 for query token with mismatched tokenVersion (revoked streaming URL)', async () => {
        // Streaming URLs with embedded tokens are long-lived -- tokenVersion check
        // prevents a stolen URL from working after a password change
        const staleToken = validToken('user-123', 1);
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            ...DB_USER,
            tokenVersion: 2,
        });

        const req = mockReq({ query: { token: staleToken } });
        const { res, status } = mockRes();
        const next = mockNext();

        await requireAuthOrToken(req, res, next);

        expect(status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });
});
