import rateLimit, { Options } from "express-rate-limit";

// Every limiter is built here. The app trusts its proxy chain
// (app.set("trust proxy", true)) because it runs behind Next.js and usually a
// reverse proxy, so express-rate-limit's warning about that setting is off.
export function createRateLimiter(options: Partial<Options>) {
    return rateLimit({
        standardHeaders: true,
        legacyHeaders: false,
        validate: { trustProxy: false },
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

// 20 failed logins per 15 minutes per IP; successful logins are not counted.
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

