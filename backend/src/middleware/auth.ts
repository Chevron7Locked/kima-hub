import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import jwt from "jsonwebtoken";
import { findApiKeyUser } from "../services/users/apiKeyStore";
import { ACQUIRE_REFUSED, mayAcquire } from "../utils/acquirePermission";

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
 * In-process 30 s cache of the user row every authenticated request needs.
 * SECURITY: `tokenVersion` (which revokes tokens) is read from here, so every
 * site that bumps it calls `invalidateUserCache`; the TTL backstops the rest.
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

/** Empty the user cache. Tests call this between cases. */
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

type AuthUser = { id: string; username: string; role: string };

/**
 * Check a JWT. Returns the user when it is valid, null when it is refused
 * outright, and undefined when it proves nothing and the next method may try.
 */
async function authenticateToken(
    token: string,
    req: Request
): Promise<AuthUser | null | undefined> {
    try {
        const decoded = jwt.verify(token, JWT_SECRET_VALIDATED) as unknown as JWTPayload;
        // A refresh token verifies with the same secret and claims, so reject it
        // here: it must only be exchanged at POST /auth/refresh, never used as a
        // credential (including on requireSessionAuth routes).
        if (decoded.type === "refresh") {
            return null;
        }
        // Stream-scoped tickets are leak-prone URL tokens: they are valid only
        // when /stream is the final path segment, whether sent in the query
        // string or as a Bearer credential. Unscoped tokens are valid everywhere.
        const isStreamScoped = decoded.scope === "stream";
        const isStreamPath = req.path.endsWith("/stream");
        if (!isStreamScoped || isStreamPath) {
            const user = await loadUser(decoded.userId);
            if (user) {
                // Reject if the password was changed since the token was issued
                if (decoded.tokenVersion === undefined || decoded.tokenVersion !== user.tokenVersion) {
                    return null;
                }
                return { id: user.id, username: user.username, role: user.role };
            }
        }
    } catch (error) {
        // An unverifiable token is no credential. Anything else is a bug in this
        // block and is logged, so it does not surface only as a silent 401.
        if (!(error instanceof jwt.JsonWebTokenError)) {
            logger.error("Token auth error:", error);
        }
    }
    return undefined;
}

/**
 * Authenticate a request by session, API key or JWT, in that order. A token in
 * the query string counts only when `checkQueryToken` is set (streaming URLs).
 */
async function authenticateRequest(
    req: Request,
    checkQueryToken: boolean = false
): Promise<AuthUser | null> {
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
            const keyUser = await findApiKeyUser(apiKey);
            if (keyUser) return keyUser;
        } catch (error) {
            logger.error("API key auth error:", error);
        }
    }

    // Check for token in query param (for streaming URLs)
    if (checkQueryToken) {
        const tokenParam = req.query.token as string;
        if (tokenParam) {
            const result = await authenticateToken(tokenParam, req);
            if (result !== undefined) return result;
        }
    }

    // Check JWT token in Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

    if (token) {
        const result = await authenticateToken(token, req);
        if (result !== undefined) return result;
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
    // Reuse the user when requireAuth already ran on this request.
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

// The acquisition gate (#238, rule in utils/acquirePermission) on a route. Deleting is never here; every
// destructive route keeps requireAdmin.
export async function requireAcquirePermission(
    req: Request,
    res: Response,
    next: NextFunction
) {
    // Reuse the user when an auth guard already ran on this request.
    const user = req.user ?? (await authenticateRequest(req, false));
    if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    req.user = user;
    if (!(await mayAcquire(user))) {
        return res.status(403).json({ error: ACQUIRE_REFUSED });
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
