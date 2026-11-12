/**
 * Auth routes on a minimal app against the real database: status codes,
 * response shapes, identical answers for a wrong password and an unknown user,
 * and invalid, expired or revoked tokens.
 */

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import authRoutes from '../../routes/auth';
import { generateToken, generateRefreshToken, clearUserCache } from '../../middleware/auth';
import { prisma } from '../../utils/db';

const TEST_SECRET = process.env.JWT_SECRET!;

const app = express();
app.use(express.json());
app.use('/auth', authRoutes);

// ── Test fixtures ─────────────────────────────────────────────────────────────

const USER = 'zz-auth-user';
const ADMIN = 'zz-auth-admin';
const VICTIM = 'zz-auth-victim';
const NEW_USER = 'zz-auth-newuser';
const PASSWORD = 'correct-password';
const ALL = [USER, ADMIN, VICTIM];

/** A signed access token for `userId`; the role in it is not what the server trusts. */
function tokenFor(userId: string, role = 'user', tokenVersion = 1): string {
    return jwt.sign({ userId, username: userId, role, tokenVersion }, TEST_SECRET, { expiresIn: '24h' });
}

const clean = async () => {
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: ALL } }, { username: NEW_USER }] } });
};

beforeAll(async () => {
    await clean();
    const passwordHash = await bcrypt.hash(PASSWORD, 4); // low rounds -- tests don't need security
    for (const [id, role] of [[USER, 'user'], [ADMIN, 'admin'], [VICTIM, 'user']]) {
        await prisma.user.create({
            data: { id, username: id, role, passwordHash, tokenVersion: 1, onboardingComplete: true },
        });
    }
});

afterAll(clean);

beforeEach(async () => {
    // A test that changes a password or token version must not leak into the next.
    await prisma.user.updateMany({
        where: { id: { in: ALL } },
        data: { passwordHash: await bcrypt.hash(PASSWORD, 4), tokenVersion: 1 },
    });
    // Auth caches the user row, so the cache must not outlive the row it saw.
    clearUserCache();
});

// ── POST /auth/login ──────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
    it('returns 400 when username or password is missing', async () => {
        const res = await request(app).post('/auth/login').send({ username: '' });
        expect(res.status).toBe(400);
        // Must not return 401 -- missing field is a different error class
        expect(res.body.error).toBeDefined();
    });

    it('returns 401 with generic message when user does not exist', async () => {
        const res = await request(app).post('/auth/login').send({
            username: 'zz-auth-nobody',
            password: 'any-password',
        });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns 401 with identical message when password is wrong (no enumeration)', async () => {
        const res = await request(app).post('/auth/login').send({
            username: USER,
            password: 'wrong-password',
        });

        expect(res.status).toBe(401);
        // Exact same error message as "user not found" -- prevents enumeration
        expect(res.body.error).toBe('Invalid credentials');
    });

    it('returns 200 with token on correct credentials', async () => {
        const res = await request(app).post('/auth/login').send({
            username: USER,
            password: PASSWORD,
        });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.refreshToken).toBeDefined();
        expect(res.body.user).toEqual({ id: USER, username: USER, role: 'user' });
    });

    it('login response never contains passwordHash', async () => {
        const res = await request(app).post('/auth/login').send({
            username: USER,
            password: PASSWORD,
        });

        // Check entire serialized response for hash leakage
        const body = JSON.stringify(res.body);
        expect(body).not.toMatch(/passwordHash/);
        expect(body).not.toMatch(/\$2b\$/); // bcrypt hash prefix
    });

    it('token contains correct claims (userId, role, tokenVersion)', async () => {
        const res = await request(app).post('/auth/login').send({
            username: USER,
            password: PASSWORD,
        });

        const decoded = jwt.verify(res.body.token, TEST_SECRET) as any;
        expect(decoded.userId).toBe(USER);
        expect(decoded.role).toBe('user');
        expect(decoded.tokenVersion).toBe(1);
        // Token must NOT contain passwordHash or any credentials
        expect(decoded.passwordHash).toBeUndefined();
    });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
    it('returns 400 when refreshToken is not provided', async () => {
        const res = await request(app).post('/auth/refresh').send({});
        expect(res.status).toBe(400);
    });

    it('returns 401 when an access token is sent instead of refresh token', async () => {
        const accessToken = generateToken({ id: USER, username: USER, role: 'user', tokenVersion: 1 });

        const res = await request(app).post('/auth/refresh').send({ refreshToken: accessToken });
        // Access token lacks type: "refresh" claim -- must reject
        expect(res.status).toBe(401);
    });

    it('returns 401 when refresh token has mismatched tokenVersion (password was changed)', async () => {
        const staleRefresh = generateRefreshToken({ id: USER, tokenVersion: 1 });
        // What change-password does to the row.
        await prisma.user.update({ where: { id: USER }, data: { tokenVersion: 2 } });

        const res = await request(app).post('/auth/refresh').send({ refreshToken: staleRefresh });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Token invalidated');
    });

    it('returns 401 when the refresh token is for a user that no longer exists', async () => {
        const res = await request(app)
            .post('/auth/refresh')
            .send({ refreshToken: generateRefreshToken({ id: 'zz-auth-gone', tokenVersion: 1 }) });
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('User not found');
    });

    it('returns new access token and refresh token on valid refresh', async () => {
        const refreshToken = generateRefreshToken({ id: USER, tokenVersion: 1 });

        const res = await request(app).post('/auth/refresh').send({ refreshToken });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(res.body.refreshToken).toBeDefined();
        expect((jwt.verify(res.body.token, TEST_SECRET) as any).userId).toBe(USER);
    });
});

// ── Admin-only routes ─────────────────────────────────────────────────────────

describe('Admin-only routes', () => {
    it('GET /auth/users returns 403 for non-admin user', async () => {
        const res = await request(app)
            .get('/auth/users')
            .set('Authorization', `Bearer ${tokenFor(USER)}`);

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Admin access required');
    });

    it('GET /auth/users returns 200 for admin user', async () => {
        const res = await request(app)
            .get('/auth/users')
            .set('Authorization', `Bearer ${tokenFor(ADMIN, 'admin')}`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.map((u: { id: string }) => u.id)).toEqual(expect.arrayContaining([USER, ADMIN]));
        expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
    });

    it('POST /auth/create-user returns 403 for non-admin', async () => {
        const res = await request(app)
            .post('/auth/create-user')
            .set('Authorization', `Bearer ${tokenFor(USER)}`)
            .send({ username: NEW_USER, password: 'password123' });

        expect(res.status).toBe(403);
        // Verify that no user was created
        expect(await prisma.user.findUnique({ where: { username: NEW_USER } })).toBeNull();
    });

    it('a token that claims admin does not make a non-admin one', async () => {
        const res = await request(app)
            .get('/auth/users')
            .set('Authorization', `Bearer ${tokenFor(USER, 'admin')}`);
        expect(res.status).toBe(403);
    });

    it('POST /auth/create-user with role injection is rejected (invalid role)', async () => {
        const res = await request(app)
            .post('/auth/create-user')
            .set('Authorization', `Bearer ${tokenFor(ADMIN, 'admin')}`)
            .send({ username: NEW_USER, password: 'password123', role: 'superadmin' });

        // 'superadmin' is not a valid role -- must be rejected
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid role');
        expect(await prisma.user.findUnique({ where: { username: NEW_USER } })).toBeNull();
    });
});

// ── POST /auth/change-password ────────────────────────────────────────────────

describe('POST /auth/change-password', () => {
    it('answers a wrong current password with 400, not the signed-out 401', async () => {
        const res = await request(app)
            .post('/auth/change-password')
            .set('Authorization', `Bearer ${tokenFor(USER)}`)
            .send({ currentPassword: 'wrong-password', newPassword: 'new-password-1' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Current password is incorrect');
        const row = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
        expect(await bcrypt.compare(PASSWORD, row.passwordHash)).toBe(true);
        expect(row.tokenVersion).toBe(1);
    });

    it('keeps this device signed in with tokens for the new version and refuses the old ones', async () => {
        const oldToken = tokenFor(USER);

        const res = await request(app)
            .post('/auth/change-password')
            .set('Authorization', `Bearer ${oldToken}`)
            .send({ currentPassword: PASSWORD, newPassword: 'new-password-1' });

        expect(res.status).toBe(200);
        expect((jwt.verify(res.body.token, TEST_SECRET) as { tokenVersion: number }).tokenVersion).toBe(2);
        expect(typeof res.body.refreshToken).toBe('string');
        const row = await prisma.user.findUniqueOrThrow({ where: { id: USER } });
        expect(row.tokenVersion).toBe(2);
        expect(await bcrypt.compare('new-password-1', row.passwordHash)).toBe(true);
        const withNew = await request(app).get('/auth/me').set('Authorization', `Bearer ${res.body.token}`);
        expect(withNew.status).toBe(200);
        const withOld = await request(app).get('/auth/me').set('Authorization', `Bearer ${oldToken}`);
        expect(withOld.status).toBe(401);
    });
});

// ── DELETE /auth/account ──────────────────────────────────────────────────────

describe('DELETE /auth/account', () => {
    it('stops the deleted account authenticating immediately, not 30 seconds later', async () => {
        // loadUser caches the user for 30s, so self-delete must clear the cache
        // or the deleted account's token keeps working.
        const token = tokenFor(VICTIM);

        // Authenticate once so the row is in the cache, exactly as the delete
        // request itself does.
        const before = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
        expect(before.status).toBe(200);

        const deleted = await request(app)
            .delete('/auth/account')
            .set('Authorization', `Bearer ${token}`);
        expect(deleted.status).toBe(200);
        expect(await prisma.user.findUnique({ where: { id: VICTIM } })).toBeNull();

        const after = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
        expect(after.status).toBe(401);
    });
});
