import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import jwt from "jsonwebtoken";
import { hashApiKey } from "../services/users/apiKeyStore";

// JWT_SECRET is required - SESSION_SECRET is used as fallback since docker-entrypoint.sh generates it
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;

if (!JWT_SECRET) {
    throw new Error(
        "JWT_SECRET or SESSION_SECRET environment variable is required for authentication"
    );
}

// Type assertion after validation - JWT_SECRET is guaranteed to be a string
export const JWT_SECRET_VALIDATED: string = JWT_SECRET;

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                username: string;
                role: string;
            };
        }
    }
}

interface JWTPayload {
    userId: string;
    username: string;
    role: string;
    tokenVersion?: number;
    type?: string;
    scope?: string;
}

export function generateToken(user: {
    id: string;
    username: string;
    role: string;
    tokenVersion: number;
}): string {
    return jwt.sign(
        {
            userId: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion
        },
        JWT_SECRET_VALIDATED,
        { expiresIn: "24h" }
    );
}

// Stream ticket TTL — tunable. 4h covers multi-hour audiobook sessions without
// requiring a mid-playback re-auth. Scoped to streaming paths only.
const STREAM_TICKET_TTL = "4h";
export const STREAM_TICKET_TTL_SECONDS = 14400; // 4 * 60 * 60

export function generateStreamTicket(user: {
    id: string;
    tokenVersion: number;
}): string {
    return jwt.sign(
        {
            userId: user.id,
            tokenVersion: user.tokenVersion,
            scope: "stream"
        },
        JWT_SECRET_VALIDATED,
        { expiresIn: STREAM_TICKET_TTL }
    );
}

export function generateRefreshToken(user: {
    id: string;
    tokenVersion: number;
}): string {
    return jwt.sign(
        {
            userId: user.id,
            tokenVersion: user.tokenVersion,
            type: "refresh"
        },
        JWT_SECRET_VALIDATED,
        { expiresIn: "30d" }
    );
}

/**
 * Helper function to authenticate a request using session, API key, or JWT
 * @param req Express request object
 * @param checkQueryToken Whether to check for token in query params (for streaming)
 * @returns User object if authenticated, null otherwise
 */
/**
 * Short-lived cache of the user row that every authenticated request needs.
 *
 * Auth hit Postgres on EVERY request, on all four paths -- session, API key,
 * query token and JWT -- and requireAdmin re-ran the whole thing from scratch,
 * so `requireAuth, requireAdmin` cost two full passes and two round trips for
 * one request. For a PWA firing cover-art, playback-state and polling requests
 * continuously this was the highest-frequency query in the system, sharing the
 * 20-connection pool with every worker.
 *
 * In-process rather than Redis on purpose: swapping a Postgres round trip for a
 * Redis round trip is not obviously a win, and this data is tiny.
 *
 * SECURITY: `tokenVersion` is what revokes issued tokens when a password
 * changes, and it is read from this cache -- so a stale entry would keep a
 * revoked token working. Every site that bumps tokenVersion calls
 * `invalidateUserCache`, making revocation immediate rather than
 * eventually-consistent. The TTL is the backstop for anything that changes the
 * row without going through those paths.
 */
const USER_CACHE_TTL_MS = 30_000;

interface CachedUser {
    id: string;
    username: string;
    role: string;
    tokenVersion: number;
}

const userCache = new Map<string, { at: number; user: CachedUser | null }>();

/** Drop a user's cached row. Call this wherever tokenVersion changes. */
export function invalidateUserCache(userId: string): void {
    userCache.delete(userId);
}

/** Drop everything; used by tests and on shutdown. */
export function clearUserCache(): void {
    userCache.clear();
}

async function loadUser(userId: string): Promise<CachedUser | null> {
    const hit = userCache.get(userId);
    if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) {
        return hit.user;
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, role: true, tokenVersion: true },
    });

    // Negative results are cached too, so a request loop with a deleted user's
    // token cannot hammer the database.
    userCache.set(userId, { at: Date.now(), user });
    return user;
}

/**
 * Record that an API key was used, at most once a minute per key.
 *
 * This was a fire-and-forget UPDATE on EVERY request authenticated by API key.
 * "Last used" is a human-facing timestamp on a settings screen; minute
 * granularity is indistinguishable there and removes a write from the hot path.
 */
const API_KEY_TOUCH_INTERVAL_MS = 60_000;
const apiKeyTouchedAt = new Map<string, number>();

function touchApiKey(apiKeyId: string): void {
    const last = apiKeyTouchedAt.get(apiKeyId) ?? 0;
    if (Date.now() - last < API_KEY_TOUCH_INTERVAL_MS) return;
    apiKeyTouchedAt.set(apiKeyId, Date.now());
    prisma.apiKey
        .update({ where: { id: apiKeyId }, data: { lastUsed: new Date() } })
        .catch(() => {});
}

async function authenticateRequest(
    req: Request,
    checkQueryToken: boolean = false
): Promise<{ id: string; username: string; role: string } | null> {
    // Check session-based auth
    if (req.session?.userId) {
        try {
            const user = await loadUser(req.session.userId);
            if (user) {
                return {
                    id: user.id,
                    username: user.username,
                    role: user.role,
                };
            }
        } catch (error) {
            logger.error("Session auth error:", error);
        }
    }

    // Check for API key in X-API-Key header
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey) {
        try {
            const apiKeyRecord = await prisma.apiKey.findUnique({
                where: { keyHash: hashApiKey(apiKey) },
                include: {
                    user: { select: { id: true, username: true, role: true } },
                },
            });

            if (apiKeyRecord && apiKeyRecord.user) {
                touchApiKey(apiKeyRecord.id);
                return apiKeyRecord.user;
            }
        } catch (error) {
            logger.error("API key auth error:", error);
        }
    }

    // Check for token in query param (for streaming URLs)
    if (checkQueryToken) {
        const tokenParam = req.query.token as string;
        if (tokenParam) {
            try {
                const decoded = jwt.verify(
                    tokenParam,
                    JWT_SECRET_VALIDATED
                ) as unknown as JWTPayload;
                // See the Bearer branch below for why `type` is checked.
                if (decoded.type === "refresh") {
                    return null;
                }
                // Stream-scoped tickets are only valid on /stream paths.
                // Unscoped tokens (web client cover-art / legacy usage) are accepted everywhere.
                // endsWith (not includes) so "/stream" must be the FINAL path segment: all stream
                // routes end in /stream (/tracks/:id/stream, /audiobooks/:id/stream, …). Substring
                // matching would wrongly accept e.g. /tracks/stream_abc (a track id starting "stream").
                const isStreamScoped = decoded.scope === "stream";
                const isStreamPath = req.path.endsWith("/stream");
                if (!isStreamScoped || isStreamPath) {
                    const user = await loadUser(decoded.userId);
                    if (user) {
                        // Validate tokenVersion - reject if password was changed
                        if (decoded.tokenVersion === undefined || decoded.tokenVersion !== user.tokenVersion) {
                            return null;
                        }
                        return { id: user.id, username: user.username, role: user.role };
                    }
                }
                // Stream-scoped ticket on a non-stream path: fall through to other auth methods
            } catch (error) {
                // Token invalid, try other methods. Log non-JWT errors: a bug in
                // this block (e.g. reading a property off an absent req field)
                // would otherwise be swallowed and surface only as a silent 401.
                if (!(error instanceof jwt.JsonWebTokenError)) {
                    logger.error("Query-token auth error:", error);
                }
            }
        }
    }

    // Check JWT token in Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET_VALIDATED) as unknown as JWTPayload;
            // A refresh token is not a credential. It is signed with the same
            // secret and carries the same `userId`/`tokenVersion`, so it
            // verifies here and passes every check below -- it simply has no
            // `scope`, which made `isStreamScoped` false and waved it through.
            // `POST /auth/refresh` already enforces the opposite direction
            // (`decoded.type !== "refresh"` is rejected there); this is the
            // missing half. Without it the 30-day token meant only to be
            // exchanged for a 24-hour one authenticated everywhere the short
            // one does, including admin routes, and -- because it is a JWT --
            // it satisfied `requireSessionAuth` on the device-bound DM routes
            // too, which is the one gate that exists to keep the
            // end-to-end-encrypted surface on a real signed-in session.
            if (decoded.type === "refresh") {
                return null;
            }
            // Stream-scoped tickets are leak-prone URL tokens; they must NOT act as a
            // full-privilege Bearer credential off the /stream paths. Mirror the
            // query-param branch above — otherwise the scope restriction is trivially
            // bypassed by sending the ticket as `Authorization: Bearer <ticket>`.
            const isStreamScoped = decoded.scope === "stream";
            const isStreamPath = req.path.endsWith("/stream");
            if (!isStreamScoped || isStreamPath) {
                const user = await loadUser(decoded.userId);
                if (user) {
                    // Validate tokenVersion - reject if password was changed
                    if (decoded.tokenVersion === undefined || decoded.tokenVersion !== user.tokenVersion) {
                        return null;
                    }
                    return { id: user.id, username: user.username, role: user.role };
                }
            }
        } catch (error) {
            // Token invalid
        }
    }

    return null;
}

export async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const user = await authenticateRequest(req, false);
    if (user) {
        req.user = user;
        return next();
    }
    return res.status(401).json({ error: "Not authenticated" });
}

export async function requireAdmin(
    req: Request,
    res: Response,
    next: NextFunction
) {
    // Reuse the result when requireAuth already ran on this request. Chained as
    // `requireAuth, requireAdmin` this used to authenticate twice from scratch.
    const user = req.user ?? (await authenticateRequest(req, false));
    if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    req.user = user;
    if (user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }
    next();
}

// For streaming URLs that may use query params or need special handling
export async function requireAuthOrToken(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const user = await authenticateRequest(req, true);
    if (user) {
        req.user = user;
        return next();
    }
    return res.status(401).json({ error: "Not authenticated" });
}
