import rateLimit from "express-rate-limit";

// Trust proxy validation is disabled because this is a self-hosted app
// running behind a reverse proxy (nginx/traefik in Docker). The app.set("trust proxy", true)
// setting is required for proper IP detection and session cookies to work.
// Since this is self-hosted (not a public API), IP spoofing to bypass rate limiting is not a concern.
const trustProxyValidation = { validate: { trustProxy: false } };

// General API rate limiter (5000 req/minute per IP)
// This is for a single-user self-hosted app, so limits should be VERY high
// Only exists to prevent infinite loops or bugs from DOS'ing the server
export const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5000, // Very high limit - personal app, not a public API
    message: "Too many requests from this IP, please try again later.",
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
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
    ...trustProxyValidation,
});

// Auth limiter for login endpoints (20 attempts/15min per IP)
// More lenient for self-hosted apps where users may have password manager issues
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Increased from 5 for self-hosted environments
    skipSuccessfulRequests: true, // Don't count successful requests
    message: "Too many login attempts, please try again in 15 minutes.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});


// Webhook limiter (120 req/minute per IP) for the Lidarr webhook endpoint, which
// is intentionally excluded from apiLimiter and may run without a configured
// secret. Bounds the "unauthenticated spoofed events / repeated full scans" abuse
// vector while staying well above any legitimate Lidarr webhook rate.
export const webhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120,
    message: "Too many webhook requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});


// Image/Cover art limiter (very high limit: 500 req/minute)
// This is for image proxying - not a security risk, just bandwidth
export const imageLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 500, // Allow 500 image requests per minute (high volume pages need this)
    message: "Too many image requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});


