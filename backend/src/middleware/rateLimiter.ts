import type { Express } from "express";
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

// 5000 requests a minute per IP: only stops a runaway client loop.
export const apiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 5000,
    message: "Too many requests from this IP, please try again later.",
    skip: (req) => {
        // Never rate limit streaming, status polling, or health endpoints.
        // Use req.baseUrl + req.path (not req.path alone, which is relative to
        // the mount point) and not req.originalUrl (which includes the query
        // string -- stream URLs carry ?token= so endsWith("/stream") would fail).
        const fullPath = req.baseUrl + req.path;
        return (
            fullPath === "/health" ||
            fullPath === "/api/health" ||
            // Track streaming: /api/library/tracks/:id/stream
            (fullPath.startsWith("/api/library/tracks/") && fullPath.endsWith("/stream")) ||
            // Podcast streaming: /api/podcasts/:podcastId/episodes/:episodeId/stream
            (fullPath.startsWith("/api/podcasts/") && fullPath.endsWith("/stream")) ||
            // Soulseek search polling: /api/soulseek/search/:searchId (no /status suffix)
            /^\/api\/soulseek\/search\/[a-f0-9-]+$/.test(fullPath) ||
            // Spotify import status: /api/spotify/import/:jobId/status
            /^\/api\/spotify\/import\/[a-zA-Z0-9_-]+\/status$/.test(fullPath)
        );
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

