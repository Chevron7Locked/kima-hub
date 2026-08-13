/**
 * API keys: minting, listing, and revoking the rows behind them.
 *
 * Two routes reach these: routes/apiKeys.ts (the settings screen, where a key
 * is a "key") and routes/deviceLink.ts (the TV/mobile pairing flow, where the
 * same row is a "device"). They were generating keys with two copies of the
 * same `randomBytes(32).toString("hex")` line; the entropy of a credential is
 * not something to keep in two places and hope they stay equal.
 *
 * The two surfaces still list and revoke differently, and those differences
 * are preserved rather than unified -- each is on the wire, and they are
 * commented where they are.
 */

import crypto from "crypto";

import { prisma } from "../../utils/db";
import { UserFacingError } from "../../utils/errors";

/** Fields safe to hand back for an existing key -- never `key` itself. */
const PUBLIC_FIELDS = {
    id: true,
    name: true,
    lastUsed: true,
    createdAt: true,
} as const;

/** 32 bytes, hex-encoded: 64 characters, 256 bits of entropy. */
function generateApiKeyValue(): string {
    return crypto.randomBytes(32).toString("hex");
}

/**
 * The one hash every consumer of `ApiKey.keyHash` has to agree on --
 * `createApiKey` below, every auth lookup (`middleware/auth.ts`'s X-API-Key
 * header, `middleware/subsonicAuth.ts`'s and `routes/subsonic/index.ts`'s
 * OpenSubsonic `apiKey=` param), and the migration that re-keyed every
 * existing row (`prisma/migrations/20260812120000_apikey_hash_at_rest`,
 * via Postgres's `pgcrypto` `digest()` -- same algorithm, same input
 * encoding, see that file's own comment for why the two never disagree).
 * SHA-256, not bcrypt: see that migration's comment for the full reasoning
 * -- the short version is that a 256-bit server-generated token has no
 * dictionary to defend against and needs an indexable lookup on every
 * request, both of which point at a deterministic hash instead of a salted
 * one.
 */
export function hashApiKey(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
}

/** A newly minted key: the stored row's public fields, plus the plaintext
 *  value -- which exists ONLY here, in memory, for the one response that
 *  hands it to the client. Nothing this shape holds is ever written back to
 *  the database; `keyHash` is what persists. */
export interface CreatedApiKey {
    id: string;
    userId: string;
    name: string;
    lastUsed: Date;
    createdAt: Date;
    key: string;
}

/**
 * Mint a key for a user.
 *
 * The plaintext is generated here, hashed for storage, and returned
 * alongside the row's own fields under the same `.key` name the row used to
 * carry directly -- both callers (`routes/apiKeys.ts`, `deviceLinkService`'s
 * redeem flow) already read `createApiKey(...).key` and hand it to the
 * client as "save this now, you won't see it again"; neither needed to
 * change, because the shape they read didn't. What changed is that the
 * database itself never holds this value -- there is no column left to read
 * it back from, which is the entire point.
 */
export async function createApiKey(userId: string, name: string): Promise<CreatedApiKey> {
    const key = generateApiKeyValue();
    const row = await prisma.apiKey.create({
        data: {
            userId,
            name,
            keyHash: hashApiKey(key),
        },
    });
    return { id: row.id, userId: row.userId, name: row.name, lastUsed: row.lastUsed, createdAt: row.createdAt, key };
}

/** A user's keys for the settings screen, newest first. */
export function listApiKeys(userId: string) {
    return prisma.apiKey.findMany({
        where: { userId },
        select: PUBLIC_FIELDS,
        orderBy: { createdAt: "desc" },
    });
}

/**
 * The same rows for the linked-devices screen, ordered by last use instead --
 * a device list answers "what is talking to my server", where a key list
 * answers "what did I create".
 */
export function listLinkedDevices(userId: string) {
    return prisma.apiKey.findMany({
        where: { userId },
        orderBy: { lastUsed: "desc" },
        select: PUBLIC_FIELDS,
    });
}

/**
 * Revoke a key the caller owns.
 *
 * The delete is scoped by userId as well as id, so a request for someone
 * else's key deletes nothing and is answered the same way as one for a key
 * that never existed -- there is no probe here that distinguishes them.
 */
export async function revokeApiKey(userId: string, keyId: string): Promise<void> {
    const deleted = await prisma.apiKey.deleteMany({
        where: {
            id: keyId,
            userId,
        },
    });

    if (deleted.count === 0) {
        throw new UserFacingError("API key not found or already deleted", 404);
    }
}

/**
 * Revoke a key from the devices screen.
 *
 * Separate from `revokeApiKey` only because its 404 says "Device not found" --
 * same ownership scoping, different word for the same row.
 */
export async function revokeLinkedDevice(userId: string, keyId: string): Promise<void> {
    const apiKey = await prisma.apiKey.findFirst({
        where: { id: keyId, userId },
    });

    if (!apiKey) {
        throw new UserFacingError("Device not found", 404);
    }

    await prisma.apiKey.delete({
        where: { id: keyId },
    });
}
