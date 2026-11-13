/**
 * Scrobble tokens fail closed: only real ciphertext from `utils/encryption`
 * resolves. The real cipher and the real database run.
 */

jest.mock("axios", () => ({
    create: () => ({ get: jest.fn(), post: jest.fn() }),
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn().mockResolvedValue(null), setex: jest.fn() },
}));
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock("../rateLimiter", () => ({
    rateLimiter: { execute: (_key: string, fn: () => unknown) => fn() },
}));

import { encrypt } from "../../utils/encryption";
import { prisma } from "../../utils/db";
import { listenBrainzService } from "../listenBrainz";

const P = "zz-lbToken-";

async function wipe() {
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}
async function storeToken(userId: string, listenbrainzToken: string) {
    await prisma.user.create({
        data: { id: userId, username: userId, passwordHash: "x", settings: { create: { listenbrainzToken } } },
    });
}
beforeAll(wipe);
afterAll(wipe);

describe("getUserToken resolves only genuine ciphertext", () => {
    beforeEach(wipe);

    it("decrypts a stored value written by encrypt()", async () => {
        await storeToken(`${P}u1`, encrypt("real-token"));
        await expect(listenBrainzService.getUserToken(`${P}u1`)).resolves.toBe("real-token");
    });

    it("returns null when no row exists", async () => {
        await prisma.user.create({ data: { id: `${P}u2`, username: `${P}u2`, passwordHash: "x" } });
        await expect(listenBrainzService.getUserToken(`${P}u2`)).resolves.toBeNull();
    });

    it("treats a hand-written plaintext value as not configured", async () => {
        await storeToken(`${P}u3`, "sneaky-plaintext");
        await expect(listenBrainzService.getUserToken(`${P}u3`)).resolves.toBeNull();
    });

    it("treats a bogus xc1.-prefixed blob as not configured", async () => {
        await storeToken(`${P}u4`, "xc1.not-really-encrypted");
        await expect(listenBrainzService.getUserToken(`${P}u4`)).resolves.toBeNull();
    });
});
