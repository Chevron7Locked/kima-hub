import type { Express, NextFunction, Request, Response } from "express";
import rateLimit, { Options } from "express-rate-limit";

/**
 * One hop: the web app, or a reverse proxy directly in front of the backend. Next.js passes the client's forwarded
 * address through and adds none, so no hop count protects direct access, where a client can claim any address. The
 * per-address limits are runaway limits only; guess limits protect the secrets.
 */
export function trustOneProxyHop(app: Express): void {
    app.set("trust proxy", 1);
}

// Every limiter is built here. These count per address: a runaway limit, never protection for a secret.
export function createRateLimiter(options: Partial<Options>) {
    return rateLimit({
        standardHeaders: true,
        legacyHeaders: false,
        ...options,
    });
}

/** `res.locals` key the access check sets once a request has passed it (see routes/access). */
export const ACCESS_PASSED = "accessPassed";

/** `path` is `prefix` or lies under it, by whole segments: "/cover-art" and "/cover-art/x", not "/cover-artX". */
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Paths the general runaway limit does not count, for a caller who has passed the access check: streaming and
 * status polling. They are counted like any other request when the check refuses them. `fullPath` is the mount plus
 * the path, not the original URL, which carries `?token=` on stream URLs.
 */
export function isUncountedPath(fullPath: string): boolean {
    return (
        // Track streaming: /api/library/tracks/:id/stream
        (fullPath.startsWith("/api/library/tracks/") && fullPath.endsWith("/stream")) ||
        // Cover art and the album cover search carry the image limit instead
        under(fullPath, "/api/library/cover-art") ||
        under(fullPath, "/api/library/album-cover") ||
        // Podcast streaming: /api/podcasts/:podcastId/episodes/:episodeId/stream
        (fullPath.startsWith("/api/podcasts/") && fullPath.endsWith("/stream")) ||
        // Audiobook streaming: /api/audiobooks/:id/stream, one range request after another while it plays
        (fullPath.startsWith("/api/audiobooks/") && fullPath.endsWith("/stream")) ||
        // Soulseek search polling: /api/soulseek/search/:searchId (no /status suffix)
        /^\/api\/soulseek\/search\/[a-f0-9-]+$/.test(fullPath) ||
        // Spotify import status: /api/spotify/import/:jobId/status
        /^\/api\/spotify\/import\/[a-zA-Z0-9_-]+\/status$/.test(fullPath)
    );
}

// 5000 requests a minute per IP: only stops a runaway client loop.
export const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 5000,
    message: "Too many requests from this IP, please try again later.",
    skip: (req, res) => {
        // Use req.baseUrl + req.path (not req.path alone, which is relative to
        // the mount point) and not req.originalUrl (which includes the query
        // string -- stream URLs carry ?token= so endsWith("/stream") would fail).
        const fullPath = req.baseUrl + req.path;
        if (fullPath === "/health" || fullPath === "/api/health") return true;
        // Streams and polling go uncounted only once the access check has passed them.
        return res.locals[ACCESS_PASSED] === true && isUncountedPath(fullPath);
    },
});

// A runaway limit: 20 failed logins per 15 minutes per address, not counting successful ones. Guess limits protect passwords.
export const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skipSuccessfulRequests: true,
    message: "Too many login attempts, please try again in 15 minutes.",
});

// Webhook limiter (120 req/minute per IP). Requests carrying the configured
// Lidarr secret skip it (routes/webhooks.ts marks them), so only unauthenticated
// traffic is bounded.
export const webhookLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: "Too many webhook requests, please slow down.",
    skip: (_req, res) => res.locals.webhookVerified === true,
});

// 3,000 image requests a minute per IP: a page shows 50 to 80 covers, so this is about 40 page visits a minute and
// only stops a runaway loop.
export const imageLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 3000,
    message: "Too many image requests, please slow down.",
});

/** Whether a Subsonic path (as the router sees it, under /rest) is the cover route, with or without `.view`. */
export function isSubsonicCoverPath(path: string): boolean {
    return /^\/getcoverart(\.view)?\/?$/i.test(path);
}

/** `res.locals` key set on a signed-in Subsonic cover request: the general Subsonic limit gives its count back. */
export const SUBSONIC_COVER_COUNTED_APART = "subsonicCoverCountedApart";

/**
 * The general Subsonic runaway limit (1,500 a minute per address). It sits in front of sign-in, which queries the
 * database on every request, so it counts every request, covers included: a stranger's cover requests cost no more
 * sign-in queries than any other. A signed-in cover request gives its count back when it finishes, because the cover
 * limit below counts it instead, so a page of covers does not use up the 1,500 that every other call shares.
 */
export const subsonicLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 1500,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.locals[SUBSONIC_COVER_COUNTED_APART] === true,
});

const subsonicSignedInCoverLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 3000,
    message: "Too many image requests, please slow down.",
});

/**
 * Subsonic covers: the same runaway limit as the web cover route (3,000 a minute per address), for a request that has
 * signed in, so it is mounted after sign-in. Other paths pass through: a path that only starts like the cover route's
 * is not a cover request and stays with the general limit.
 */
export function subsonicCoverLimiter(req: Request, res: Response, next: NextFunction): void {
    if (!isSubsonicCoverPath(req.path)) {
        next();
        return;
    }
    res.locals[SUBSONIC_COVER_COUNTED_APART] = true;
    subsonicSignedInCoverLimiter(req, res, next);
}

