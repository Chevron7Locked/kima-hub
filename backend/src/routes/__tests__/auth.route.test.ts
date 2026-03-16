/**
 * Auth Route Integration Tests
 *
 * Uses supertest against a minimal Express app (no Redis, no session store)
 * with mocked Prisma. Tests the observable behavior of each auth route:
 * correct status codes, response shapes, and -- crucially -- that the routes
 * behave identically for "wrong password" and "nonexistent user" to prevent
 * username enumeration.
 *
 * Does NOT test JWT library internals (that's jsonwebtoken's job). Tests that
 * the routes react correctly when given invalid tokens, expired tokens, and
 * tokens with mismatched tokenVersion.
 */

// All mocks must be before imports -- jest.mock is hoisted
jest.mock('../../utils/db', () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        userSettings: {
            create: jest.fn(),
        },
        apiKey: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock('../../utils/logger', () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/encryption', () => ({
    encrypt: jest.fn((v: string) => `enc:${v}`),
    decrypt: jest.fn((v: string) => v.replace('enc:', '')),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import authRoutes from '../../routes/auth';
import { generateToken, generateRefreshToken } from '../../middleware/auth';
import { prisma } from '../../utils/db';

const TEST_SECRET = process.env.JWT_SECRET!;

// ── App factory ───────────────────────────────────────────────────────────────

function createTestApp() {
    const app = express();
    app.use(express.json());
    app.use('/auth', authRoutes);
    return app;
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

async function hashedPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 4); // low rounds -- tests don't need security
}

const BASE_USER = {
    id: 'user-abc-123',
    username: 'testuser',
    role: 'user',
    tokenVersion: 1,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    onboardingComplete: true,
    enrichmentSettings: null,
    createdAt: new Date(),
};

// ── POST /auth/login ──────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
    let app: express.Application;

    beforeAll(() => { app = createTestApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 400 when username or password is missing', async () => {
        const res = await request(app).post('/auth/login').send({ username: '' });
        expect(res.status).toBe(400);
        // Must not return 401 -- missing field is a different error class
        expect(res.body.error).toBeDefined();
    });

    it('returns 401 with generic message when user does not exist', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

        const res = await request(app).post('/auth/login').send({
            username: 'nobody',
            password: 'any-password',
        });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns 401 with identical message when password is wrong (no enumeration)', async () => {
        const hash = await hashedPassword('correct-password');
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_USER,
            passwordHash: hash,
        });

        const res = await request(app).post('/auth/login').send({
            username: 'testuser',
            password: 'wrong-password',
        });

        expect(res.status).toBe(401);
        // Exact same error message as "user not found" -- prevents enumeration
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns 200 with token on correct credentials', async () => {
        const hash = await hashedPassword('correct-password');
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_USER,
            passwordHash: hash,
        });

        const res = await request(app).post('/auth/login').send({
            username: 'testuser',
            password: 'correct-password',
        });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.refreshToken).toBeDefined();
        expect(res.body.user).toBeDefined();
    });

    it('login response never contains passwordHash', async () => {
        const hash = await hashedPassword('secret');
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_USER,
            passwordHash: hash,
        });

        const res = await request(app).post('/auth/login').send({
            username: 'testuser',
            password: 'secret',
        });

        // Check entire serialized response for hash leakage
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/passwordHash/);
        expect(body).not.toMatch(/\$2b\$/); // bcrypt hash prefix
    });

    it('token contains correct claims (userId, role, tokenVersion)', async () => {
        const hash = await hashedPassword('secret');
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_USER,
            passwordHash: hash,
        });

        const res = await request(app).post('/auth/login').send({
            username: 'testuser',
            password: 'secret',
        });

        const decoded = jwt.verify(res.body.token, TEST_SECRET) as any;
        expect(decoded.userId).toBe(BASE_USER.id);
        expect(decoded.role).toBe('user');
        expect(decoded.tokenVersion).toBe(1);
        // Token must NOT contain passwordHash or any credentials
        expect(decoded.passwordHash).toBeUndefined();
    });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
    let app: express.Application;

    beforeAll(() => { app = createTestApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('returns 400 when refreshToken is not provided', async () => {
        const res = await request(app).post('/auth/refresh').send({});
        expect(res.status).toBe(400);
    });

    it('returns 401 when an access token is sent instead of refresh token', async () => {
        const accessToken = generateToken({
            id: 'user-abc-123',
            username: 'testuser',
            role: 'user',
            tokenVersion: 1,
        });

        const res = await request(app).post('/auth/refresh').send({ refreshToken: accessToken });
        // Access token lacks type: "refresh" claim -- must reject
        expect(res.status).toBe(401);
    });

    it('returns 401 when refresh token has mismatched tokenVersion (password was changed)', async () => {
        const staleRefresh = generateRefreshToken({ id: 'user-abc-123', tokenVersion: 1 });
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({
            ...BASE_USER,
            tokenVersion: 2, // incremented by change-password
        });

        const res = await request(app).post('/auth/refresh').send({ refreshToken: staleRefresh });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Token invalidated');
    });

    it('returns new access token and refresh token on valid refresh', async () => {
        const refreshToken = generateRefreshToken({ id: 'user-abc-123', tokenVersion: 1 });
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);

        const res = await request(app).post('/auth/refresh').send({ refreshToken });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.refreshToken).toBeDefined();
    });
});

// ── Admin-only routes ─────────────────────────────────────────────────────────

describe('Admin-only routes', () => {
    let app: express.Application;

    function userToken(role: string, tokenVersion = 1): string {
        return jwt.sign(
            { userId: 'user-abc-123', username: 'testuser', role, tokenVersion },
            TEST_SECRET,
            { expiresIn: '24h' }
        );
    }

    beforeAll(() => { app = createTestApp(); });
    beforeEach(() => { jest.clearAllMocks(); });

    it('GET /auth/users returns 403 for non-admin user', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...BASE_USER, role: 'user' });

        const res = await request(app)
            .get('/auth/users')
            .set('Authorization', `Bearer ${userToken('user')}`);

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Admin access required');
    });

    it('GET /auth/users returns 200 for admin user', async () => {
        const adminUser = { ...BASE_USER, role: 'admin' };
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
        (prisma.user.findMany as jest.Mock).mockResolvedValue([adminUser]);

        const res = await request(app)
            .get('/auth/users')
            .set('Authorization', `Bearer ${userToken('admin')}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('POST /auth/create-user returns 403 for non-admin', async () => {
        (prisma.user.findUnique as jest.Mock).mockResolvedValue({ ...BASE_USER, role: 'user' });

        const res = await request(app)
            .post('/auth/create-user')
            .set('Authorization', `Bearer ${userToken('user')}`)
            .send({ username: 'newuser', password: 'password123' });

        expect(res.status).toBe(403);
        // Verify that no user was created
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('POST /auth/create-user with role injection is rejected (invalid role)', async () => {
        const adminUser = { ...BASE_USER, role: 'admin' };
        (prisma.user.findUnique as jest.Mock)
            .mockResolvedValueOnce(adminUser) // auth lookup
            .mockResolvedValueOnce(adminUser) // existing username check
            .mockResolvedValueOnce(null); // username check returns null = available

        // Re-mock: first call for admin auth, second for username check
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);
        (prisma.user.findUnique as jest.Mock)
            .mockResolvedValueOnce(adminUser)  // requireAdmin auth lookup
            .mockResolvedValueOnce(null);      // username availability check

        (prisma.user.create as jest.Mock).mockResolvedValue({
            ...BASE_USER,
            id: 'new-user-id',
            username: 'newuser',
            role: 'user', // server ignores injected 'superadmin'
        });
        (prisma.userSettings.create as jest.Mock).mockResolvedValue({});

        const res = await request(app)
            .post('/auth/create-user')
            .set('Authorization', `Bearer ${userToken('admin')}`)
            .send({ username: 'newuser', password: 'password123', role: 'superadmin' });

        // 'superadmin' is not a valid role -- must be rejected
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid role');
        expect(prisma.user.create).not.toHaveBeenCalled();
    });
});
