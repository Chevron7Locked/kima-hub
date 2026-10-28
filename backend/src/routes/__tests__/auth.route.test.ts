/**
 * Auth routes on a minimal app with mocked Prisma: status codes, response
 * shapes, identical answers for a wrong password and an unknown user, and
 * invalid, expired or revoked tokens.
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
import { generateToken, generateRefreshToken, clearUserCache} from '../../middleware/auth';
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
    createdAt: new Date(),
};

// ── POST /auth/login ──────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
    let app: express.Application;

    beforeAll(() => { app = createTestApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        // Auth caches the user row; these tests reuse one userId across roles.
        clearUserCache();
    });

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
    beforeEach(() => {
        jest.clearAllMocks();
        // Auth caches the user row; these tests reuse one userId across roles.
        clearUserCache();
    });

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
    beforeEach(() => {
        jest.clearAllMocks();
        // Auth caches the user row; these tests reuse one userId across roles.
        clearUserCache();
    });

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
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(adminUser);

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

// ── POST /auth/change-password ────────────────────────────────────────────────

describe('POST /auth/change-password', () => {
    let app: express.Application;
    beforeAll(() => { app = createTestApp(); });
    beforeEach(() => { jest.clearAllMocks(); clearUserCache(); });

    it('answers a wrong current password with 400, not the signed-out 401', async () => {
        const token = jwt.sign(
            { userId: 'user-abc-123', username: 'testuser', role: 'user', tokenVersion: 1 },
            TEST_SECRET,
            { expiresIn: '24h' },
        );
        // mockReset: an earlier test can leave a queued one-off answer behind.
        (prisma.user.findUnique as jest.Mock).mockReset().mockResolvedValue({
            ...BASE_USER,
            passwordHash: await hashedPassword('right-password'),
        });

        const res = await request(app)
            .post('/auth/change-password')
            .set('Authorization', `Bearer ${token}`)
            .send({ currentPassword: 'wrong-password', newPassword: 'new-password-1' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Current password is incorrect');
    });

    it('keeps this device signed in with tokens for the new version and refuses the old ones', async () => {
        const oldToken = jwt.sign(
            { userId: BASE_USER.id, username: BASE_USER.username, role: 'user', tokenVersion: 1 },
            TEST_SECRET,
            { expiresIn: '24h' },
        );
        const stored = { ...BASE_USER, role: 'user', tokenVersion: 1, passwordHash: await hashedPassword('right-password') };
        (prisma.user.findUnique as jest.Mock).mockReset().mockImplementation(async () => stored);
        (prisma.user.update as jest.Mock).mockReset().mockImplementation(async () => {
            stored.tokenVersion = 2;
            return { id: stored.id, username: stored.username, role: stored.role, tokenVersion: 2 };
        });

        const res = await request(app)
            .post('/auth/change-password')
            .set('Authorization', `Bearer ${oldToken}`)
            .send({ currentPassword: 'right-password', newPassword: 'new-password-1' });

        expect(res.status).toBe(200);
        expect((jwt.verify(res.body.token, TEST_SECRET) as { tokenVersion: number }).tokenVersion).toBe(2);
        expect(typeof res.body.refreshToken).toBe('string');
        const withNew = await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.token}`);
        expect(withNew.status).toBe(200);
        const withOld = await request(app).get('/auth/me').set('Authorization', `Bearer ${oldToken}`);
        expect(withOld.status).toBe(401);
    });
});

// ── DELETE /auth/account ──────────────────────────────────────────────────────

describe('DELETE /auth/account', () => {
    let app: express.Application;

    function tokenFor(role: string, tokenVersion = 1): string {
        return jwt.sign(
            { userId: BASE_USER.id, username: BASE_USER.username, role, tokenVersion },
            TEST_SECRET,
            { expiresIn: '24h' }
        );
    }

    beforeAll(() => { app = createTestApp(); });
    beforeEach(() => {
        jest.clearAllMocks();
        (prisma.user.findUnique as jest.Mock).mockReset();
        (prisma.user.delete as jest.Mock).mockReset();
        clearUserCache();
    });

    it('stops the deleted account authenticating immediately, not 30 seconds later', async () => {
        // loadUser caches the user for 30s, so self-delete must clear the cache
        // or the deleted account's token keeps working.
        const token = tokenFor('user');
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(BASE_USER);
        (prisma.user.delete as jest.Mock).mockResolvedValue({});
        (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
            async (fn: (tx: unknown) => Promise<unknown>) =>
                fn({
                    user: { count: jest.fn().mockResolvedValue(2), delete: prisma.user.delete },
                })
        );

        // Authenticate once so the row is in the cache, exactly as the delete
        // request itself does.
        const before = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
        expect(before.status).toBe(200);

        const deleted = await request(app)
            .delete('/auth/account')
            .set('Authorization', `Bearer ${token}`);
        expect(deleted.status).toBe(200);
        expect(prisma.user.delete).toHaveBeenCalled();

        // The row is gone now.
        (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

        const after = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
        expect(after.status).toBe(401);
    });
});
