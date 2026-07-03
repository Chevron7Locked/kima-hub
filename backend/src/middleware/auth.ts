import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import jwt from "jsonwebtoken";

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
async function authenticateRequest(
    req: Request,
    checkQueryToken: boolean = false
): Promise<{ id: string; username: string; role: string } | null> {
    // Check session-based auth
    if (req.session?.userId) {
        try {
            const user = await prisma.user.findUnique({
                where: { id: req.session.userId },
                select: { id: true, username: true, role: true },
            });
            if (user) return user;
        } catch (error) {
            logger.error("Session auth error:", error);
        }
    }

    // Check for API key in X-API-Key header
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey) {
        try {
            const apiKeyRecord = await prisma.apiKey.findUnique({
                where: { key: apiKey },
                include: {
                    user: { select: { id: true, username: true, role: true } },
                },
            });

            if (apiKeyRecord && apiKeyRecord.user) {
                // Update last used timestamp (async, don't block)
                prisma.apiKey
                    .update({
                        where: { id: apiKeyRecord.id },
                        data: { lastUsed: new Date() },
                    })
                    .catch(() => {});

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
                // Stream-scoped tickets are only valid on /stream paths.
                // Unscoped tokens (web client cover-art / legacy usage) are accepted everywhere.
                // endsWith (not includes) so "/stream" must be the FINAL path segment: all stream
                // routes end in /stream (/tracks/:id/stream, /audiobooks/:id/stream, …). Substring
                // matching would wrongly accept e.g. /tracks/stream_abc (a track id starting "stream").
                const isStreamScoped = decoded.scope === "stream";
                const isStreamPath = req.path.endsWith("/stream");
                if (!isStreamScoped || isStreamPath) {
                    const user = await prisma.user.findUnique({
                        where: { id: decoded.userId },
                        select: { id: true, username: true, role: true, tokenVersion: true },
                    });
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
                // Token invalid, try other methods
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
            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: { id: true, username: true, role: true, tokenVersion: true },
            });
            if (user) {
                // Validate tokenVersion - reject if password was changed
                if (decoded.tokenVersion === undefined || decoded.tokenVersion !== user.tokenVersion) {
                    return null;
                }
                return { id: user.id, username: user.username, role: user.role };
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
    const user = await authenticateRequest(req, false);
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
