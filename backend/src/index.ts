import express from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { redisClient } from "./utils/redis";
import { prisma } from "./utils/db";
import { logger } from "./utils/logger";

import authRoutes from "./routes/auth";
import onboardingRoutes from "./routes/onboarding";
import libraryRoutes from "./routes/library";
import playsRoutes from "./routes/plays";
import settingsRoutes from "./routes/settings";
import systemSettingsRoutes from "./routes/systemSettings";
import listeningStateRoutes from "./routes/listeningState";
import playbackStateRoutes from "./routes/playbackState";
import offlineRoutes from "./routes/offline";
import playlistsRoutes from "./routes/playlists";
import searchRoutes from "./routes/search";
import recommendationsRoutes from "./routes/recommendations";
import downloadsRoutes from "./routes/downloads";
import webhooksRoutes from "./routes/webhooks";
import audiobooksRoutes from "./routes/audiobooks";
import podcastsRoutes from "./routes/podcasts";
import artistsRoutes from "./routes/artists";
import soulseekRoutes from "./routes/soulseek";
import discoverRoutes from "./routes/discover";
import apiKeysRoutes from "./routes/apiKeys";
import mixesRoutes from "./routes/mixes";
import enrichmentRoutes from "./routes/enrichment";
import homepageRoutes from "./routes/homepage";
import deviceLinkRoutes from "./routes/deviceLink";
import spotifyRoutes from "./routes/spotify";
import notificationsRoutes from "./routes/notifications";
import browseRoutes from "./routes/browse";
import analysisRoutes from "./routes/analysis";
import releasesRoutes from "./routes/releases";
import vibeRoutes from "./routes/vibe";
import systemRoutes from "./routes/system";
import eventsRoutes from "./routes/events";
import { subsonicRouter } from "./routes/subsonic/index";
import { dataCacheService } from "./services/dataCache";
import { enrichmentStateService } from "./services/enrichmentState";
import { errorHandler } from "./middleware/errorHandler";
import { requireAuth, requireAdmin } from "./middleware/auth";
import {
    authLimiter,
    apiLimiter,
    imageLimiter,
} from "./middleware/rateLimiter";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger";

const app = express();

// Middleware
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
    })
);
app.use(
    cors({
        origin: (origin, callback) => {
            // For self-hosted apps: allow all origins by default
            // Users deploy on their own domains/IPs - we can't predict them
            // Security is handled by authentication, not CORS
            if (!origin) {
                // Allow requests with no origin (same-origin, curl, etc.)
                callback(null, true);
            } else if (
                config.allowedOrigins === true ||
                config.nodeEnv === "development"
            ) {
                // Explicitly allow all origins
                callback(null, true);
            } else if (
                Array.isArray(config.allowedOrigins) &&
                config.allowedOrigins.length > 0
            ) {
                // Check against specific allowed origins if configured
                if (config.allowedOrigins.includes(origin)) {
                    callback(null, true);
                } else {
                    // For self-hosted: allow anyway but log it
                    // Users shouldn't have to configure CORS for their own app
                    logger.debug(
                        `[CORS] Origin ${origin} not in allowlist, allowing anyway (self-hosted)`
                    );
                    callback(null, true);
                }
            } else {
                // No restrictions - allow all (self-hosted default)
                callback(null, true);
            }
        },
        credentials: true,
    })
);
app.use(express.json({ limit: "1mb" })); // Increased from 100KB default to support large queue payloads

// Session
// Trust proxy for reverse proxy setups (nginx, traefik, etc.)
// Set to true to trust all proxies in the chain (common in Docker/Portainer setups)
app.set("trust proxy", true);

app.use(
    session({
        store: new RedisStore({
            client: redisClient,
            ttl: 7 * 24 * 60 * 60, // 7 days in seconds - must match cookie maxAge
        }),
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        proxy: true, // Trust the reverse proxy
        cookie: {
            httpOnly: true,
            // Self-hosted app: default to HTTP-friendly settings for local network use
            // Set SECURE_COOKIES=true if running behind HTTPS reverse proxy
            secure: process.env.SECURE_COOKIES === "true",
            sameSite: "lax",
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
        },
    })
);

// Routes - All API routes prefixed with /api for clear separation from frontend
// Apply rate limiting to auth routes
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/onboarding", onboardingRoutes); // Public onboarding routes

// Apply general API rate limiting to all API routes
app.use("/api/api-keys", apiLimiter, apiKeysRoutes);
app.use("/api/device-link", apiLimiter, deviceLinkRoutes);
// NOTE: /api/library has its own rate limiting (imageLimiter for cover-art, apiLimiter for others)
app.use("/api/library", libraryRoutes);
app.use("/api/plays", apiLimiter, playsRoutes);
app.use("/api/settings", apiLimiter, settingsRoutes);
app.use("/api/system-settings", apiLimiter, systemSettingsRoutes);
app.use("/api/listening-state", apiLimiter, listeningStateRoutes);
app.use("/api/playback-state", playbackStateRoutes); // No rate limit - syncs frequently
app.use("/api/offline", apiLimiter, offlineRoutes);
app.use("/api/playlists", apiLimiter, playlistsRoutes);
app.use("/api/search", apiLimiter, searchRoutes);
app.use("/api/recommendations", apiLimiter, recommendationsRoutes);
app.use("/api/downloads", apiLimiter, downloadsRoutes);
app.use("/api/notifications", apiLimiter, notificationsRoutes);
app.use("/api/webhooks", webhooksRoutes); // Webhooks should not be rate limited
// NOTE: /api/audiobooks has its own rate limiting (imageLimiter for covers, apiLimiter for others)
app.use("/api/audiobooks", audiobooksRoutes);
app.use("/api/podcasts", apiLimiter, podcastsRoutes);
app.use("/api/artists", apiLimiter, artistsRoutes);
app.use("/api/soulseek", apiLimiter, soulseekRoutes);
app.use("/api/discover", apiLimiter, discoverRoutes);
app.use("/api/mixes", apiLimiter, mixesRoutes);
app.use("/api/enrichment", apiLimiter, enrichmentRoutes);
app.use("/api/homepage", apiLimiter, homepageRoutes);
app.use("/api/spotify", apiLimiter, spotifyRoutes);
app.use("/api/browse", apiLimiter, browseRoutes);
app.use("/api/analysis", apiLimiter, analysisRoutes);
app.use("/api/releases", apiLimiter, releasesRoutes);
app.use("/api/vibe", apiLimiter, vibeRoutes);
app.use("/api/system", apiLimiter, systemRoutes);
// SSE - no rate limit, long-lived connections
app.use("/api/events", eventsRoutes);

// Subsonic-compatible API — rate limiting is internal to the router
app.use("/rest", subsonicRouter);

// Health check (keep at root for simple container health checks)
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});
app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
});

// Prometheus metrics endpoint
app.get("/api/metrics", async (req, res) => {
    try {
        const { getMetrics } = await import("./utils/metrics");
        res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.send(await getMetrics());
    } catch (error) {
        logger.error("Error generating metrics:", error);
        res.status(500).send("Error generating metrics");
    }
});

// Swagger API Documentation
// In production: require auth unless DOCS_PUBLIC=true
// In development: always public for easier testing
const docsMiddleware =
    config.nodeEnv === "production" && process.env.DOCS_PUBLIC !== "true"
        ? [requireAuth]
        : [];

app.use(
    "/api/docs",
    ...docsMiddleware,
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
        customCss: ".swagger-ui .topbar { display: none }",
        customSiteTitle: "Kima API Documentation",
    })
);

// Serve raw OpenAPI spec
app.get("/api/docs.json", ...docsMiddleware, (req, res) => {
    res.json(swaggerSpec);
});

// Error handler
app.use(errorHandler);

// Health check functions
async function checkPostgresConnection() {
    try {
        await prisma.$queryRaw`SELECT 1`;
        logger.debug("✓ PostgreSQL connection verified");
    } catch (error) {
        logger.error("✗ PostgreSQL connection failed:", {
            error: error instanceof Error ? error.message : String(error),
            databaseUrl: config.databaseUrl?.replace(/:[^:@]+@/, ":***@"), // Hide password
        });
        logger.error("Unable to connect to PostgreSQL. Please ensure:");
        logger.error(
            "  1. PostgreSQL is running on the correct port (default: 5433)"
        );
        logger.error("  2. DATABASE_URL in .env is correct");
        logger.error("  3. Database credentials are valid");
        process.exit(1);
    }
}

async function checkRedisConnection() {
    try {
        // Check if Redis client is actually connected
        // The redis client has automatic reconnection, so we need to check status first
        if (!redisClient.isReady) {
            throw new Error(
                "Redis client is not ready - connection failed or still connecting"
            );
        }

        // If connected, verify with ping
        await redisClient.ping();
        logger.debug("✓ Redis connection verified");
    } catch (error) {
        logger.error("✗ Redis connection failed:", {
            error: error instanceof Error ? error.message : String(error),
            redisUrl: config.redisUrl?.replace(/:[^:@]+@/, ":***@"), // Hide password if any
        });
        logger.error("Unable to connect to Redis. Please ensure:");
        logger.error(
            "  1. Redis is running on the correct port (default: 6380)"
        );
        logger.error("  2. REDIS_URL in .env is correct");
        process.exit(1);
    }
}

async function checkPasswordReset() {
    const resetPassword = process.env.ADMIN_RESET_PASSWORD;
    if (!resetPassword) return;

    const bcrypt = await import("bcrypt");
    const adminUser = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    if (!adminUser) {
        logger.warn("[Password Reset] No admin user found");
        return;
    }

    const hashedPassword = await bcrypt.hash(resetPassword, 10);
    await prisma.user.update({
        where: { id: adminUser.id },
        data: { passwordHash: hashedPassword },
    });
    logger.warn("[Password Reset] Admin password has been reset via ADMIN_RESET_PASSWORD env var. Remove this env var and restart.");
}

app.listen(config.port, "0.0.0.0", async () => {
    // Verify database connections before proceeding
    await checkPostgresConnection();
    await checkRedisConnection();

    // Check for admin password reset
    await checkPasswordReset();

    logger.debug(
        `Kima API running on port ${config.port} (accessible on all network interfaces)`
    );

    // Enable slow query monitoring in development
    if (config.nodeEnv === "development") {
        const { enableSlowQueryMonitoring } = await import(
            "./utils/queryMonitor"
        );
        enableSlowQueryMonitoring();
    }

    // Initialize music configuration (reads from SystemSettings)
    const { initializeMusicConfig } = await import("./config");
    await initializeMusicConfig();

    // Initialize BullMQ workers
    await import("./workers");

    // Set up Bull Board dashboard
    const { createBullBoard } = await import("@bull-board/api");
    const { BullMQAdapter } = await import("@bull-board/api/bullMQAdapter");
    const { ExpressAdapter } = await import("@bull-board/express");
    const { scanQueue, discoverQueue } = await import(
        "./workers/queues"
    );
    const { artistQueue, trackQueue, vibeQueue, podcastQueue } = await import(
        "./workers/enrichmentQueues"
    );

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/api/admin/queues");

    createBullBoard({
        queues: [
            new BullMQAdapter(scanQueue),
            new BullMQAdapter(discoverQueue),
            new BullMQAdapter(artistQueue),
            new BullMQAdapter(trackQueue),
            new BullMQAdapter(vibeQueue),
            new BullMQAdapter(podcastQueue),
        ],
        serverAdapter,
    });

    app.use(
        "/api/admin/queues",
        requireAuth,
        requireAdmin,
        serverAdapter.getRouter()
    );
    logger.debug(
        "Bull Board dashboard available at /api/admin/queues (admin-only)"
    );

    // Note: Native library scanning is now triggered manually via POST /library/scan
    // No automatic sync on startup - user must manually scan their music folder

    // Enrichment worker enabled for OWNED content only
    // - Background enrichment: Genres, MBIDs, similar artists for owned albums/artists
    // - On-demand fetching: Artist images, bios when browsing (cached in Redis 7 days)
    logger.debug(
        "Background enrichment enabled for owned content (genres, MBIDs, etc.)"
    );

    // Warm up Redis cache from database on startup
    // This populates Redis with existing artist images and album covers
    // so first page loads are instant instead of waiting for cache population
    dataCacheService.warmupCache().catch((err) => {
        logger.error("Cache warmup failed:", err);
    });

    // Webhook reconciliation - runs every 5 minutes to process missed events
    const { webhookReconciliation } = await import("./jobs/webhookReconciliation");
    webhookReconciliation.start();

    // Webhook event cleanup - runs daily to remove old processed events
    const { webhookEventStore } = await import("./services/webhookEventStore");
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    // Run cleanup on startup (async, don't block)
    webhookEventStore.cleanupOldEvents(30).catch((err) => {
        logger.error("Webhook event cleanup failed:", err);
    });

    // Schedule daily webhook event cleanup
    webhookCleanupInterval = setInterval(() => {
        webhookEventStore.cleanupOldEvents(30).catch((err) => {
            logger.error("Scheduled webhook event cleanup failed:", err);
        });
    }, TWENTY_FOUR_HOURS);
    logger.debug("Webhook event cleanup scheduled (daily, 30-day expiry)");

    // Podcast cache cleanup - runs daily to remove cached episodes older than 30 days
    const { cleanupExpiredCache } = await import("./services/podcastDownload");

    // Run cleanup on startup (async, don't block)
    cleanupExpiredCache().catch((err) => {
        logger.error("Podcast cache cleanup failed:", err);
    });

    // Schedule daily cleanup (every 24 hours)
    podcastCleanupInterval = setInterval(() => {
        cleanupExpiredCache().catch((err) => {
            logger.error("Scheduled podcast cache cleanup failed:", err);
        });
    }, TWENTY_FOUR_HOURS);
    logger.debug("Podcast cache cleanup scheduled (daily, 30-day expiry)");

    // Auto-sync audiobooks on startup if cache is empty
    // This prevents "disappeared" audiobooks after container rebuilds
    (async () => {
        try {
            const { getSystemSettings } = await import(
                "./utils/systemSettings"
            );
            const settings = await getSystemSettings();

            // Only proceed if Audiobookshelf is configured and enabled
            if (
                settings?.audiobookshelfEnabled &&
                settings?.audiobookshelfUrl
            ) {
                // Check if cache is empty
                const cachedCount = await prisma.audiobook.count();

                if (cachedCount === 0) {
                    logger.debug(
                        "[STARTUP] Audiobook cache is empty - auto-syncing from Audiobookshelf..."
                    );
                    const { audiobookCacheService } = await import(
                        "./services/audiobookCache"
                    );
                    const result = await audiobookCacheService.syncAll();
                    logger.debug(
                        `[STARTUP] Audiobook auto-sync complete: ${result.synced} audiobooks cached`
                    );
                } else {
                    logger.debug(
                        `[STARTUP] Audiobook cache has ${cachedCount} entries - skipping auto-sync`
                    );
                }
            }
        } catch (err) {
            logger.error("[STARTUP] Audiobook auto-sync failed:", err);
            // Non-fatal - user can manually sync later
        }
    })();

    // Reconcile download queue state with database
    const { downloadQueueManager } = await import("./services/downloadQueue");
    try {
        const result = await downloadQueueManager.reconcileOnStartup();
        logger.debug(
            `Download queue reconciled: ${result.loaded} active, ${result.failed} marked failed`
        );
    } catch (err) {
        logger.error("Download queue reconciliation failed:", err);
        // Non-fatal - queue will start fresh
    }

    // Auto-backfill artist counts if needed (for library filtering performance)
    // This runs in the background and doesn't block startup
    (async () => {
        try {
            const { isBackfillNeeded, backfillAllArtistCounts } = await import(
                "./services/artistCountsService"
            );
            const needsBackfill = await isBackfillNeeded();
            if (needsBackfill) {
                logger.info(
                    "[STARTUP] Artist counts need backfilling, starting in background..."
                );
                const result = await backfillAllArtistCounts();
                logger.info(
                    `[STARTUP] Artist counts backfill complete: ${result.processed} processed, ${result.errors} errors`
                );
            } else {
                logger.debug("[STARTUP] Artist counts already populated");
            }
        } catch (err) {
            logger.error("[STARTUP] Artist counts backfill failed:", err);
            // Non-fatal - backfill can be triggered manually
        }
    })();

    // Auto-backfill images if needed (download external URLs locally)
    // This runs in the background and doesn't block startup
    (async () => {
        try {
            const { isImageBackfillNeeded, backfillAllImages } = await import(
                "./services/imageBackfill"
            );
            const status = await isImageBackfillNeeded();
            if (status.needed) {
                logger.info(
                    `[STARTUP] Image backfill needed: ${status.artistsWithExternalUrls} artists, ${status.albumsWithExternalUrls} albums with external URLs`
                );
                await backfillAllImages();
                logger.info("[STARTUP] Image backfill complete");
            } else {
                logger.debug("[STARTUP] All images already stored locally");
            }
        } catch (err) {
            logger.error("[STARTUP] Image backfill failed:", err);
            // Non-fatal - backfill can be triggered manually via API
        }
    })();
});

// Graceful shutdown handling
let isShuttingDown = false;
let healthCheckInterval: NodeJS.Timeout | null = null;
let podcastCleanupInterval: NodeJS.Timeout | null = null;
let webhookCleanupInterval: NodeJS.Timeout | null = null;

async function gracefulShutdown(signal: string) {
    if (isShuttingDown) {
        logger.debug("Shutdown already in progress...");
        return;
    }

    isShuttingDown = true;
    logger.debug(`\nReceived ${signal}. Starting graceful shutdown...`);

    try {
        // Shutdown workers (intervals, crons, queues)
        const { shutdownWorkers } = await import("./workers");
        await shutdownWorkers();

        // Clear scheduled intervals
        if (healthCheckInterval) clearInterval(healthCheckInterval);
        if (podcastCleanupInterval) clearInterval(podcastCleanupInterval);
        if (webhookCleanupInterval) clearInterval(webhookCleanupInterval);

        // Stop webhook reconciliation
        const { webhookReconciliation } = await import("./jobs/webhookReconciliation");
        webhookReconciliation.stop();

        // Disconnect Soulseek
        logger.debug("Disconnecting Soulseek...");
        const { soulseekService } = await import("./services/soulseek");
        soulseekService.disconnect();

        // Disconnect enrichment state Redis connections
        logger.debug("Disconnecting enrichment state service...");
        await enrichmentStateService.disconnect();

        // Close Redis connection
        logger.debug("Closing Redis connection...");
        await redisClient.quit();

        // Close Prisma connection
        logger.debug("Closing database connection...");
        await prisma.$disconnect();

        logger.debug("Graceful shutdown complete");
        process.exit(0);
    } catch (error) {
        logger.error("Error during shutdown:", error);
        process.exit(1);
    }
}

// Handle termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Global error handlers to prevent silent crashes
process.on("unhandledRejection", (reason, promise) => {
    logger.error("Unhandled Promise Rejection:", {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
    });
    // Don't exit - log and continue running
    // This prevents silent crashes from unhandled promises
});

process.on("uncaughtException", (error) => {
    logger.error("Uncaught Exception - initiating graceful shutdown:", {
        message: error.message,
        stack: error.stack,
    });
    // Attempt graceful shutdown for uncaught exceptions
    gracefulShutdown("uncaughtException").catch(() => {
        process.exit(1);
    });
});

// Periodic health check to keep database connections alive and detect issues early
// Runs every 5 minutes to prevent idle connection drops
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
healthCheckInterval = setInterval(async () => {
    try {
        // Ping PostgreSQL
        await prisma.$queryRaw`SELECT 1`;

        // Ping Redis
        if (redisClient.isReady) {
            await redisClient.ping();
        }
    } catch (error) {
        logger.error("Health check failed - connections may be stale:", {
            error: error instanceof Error ? error.message : String(error),
        });
        // Attempt to reconnect Prisma
        try {
            await prisma.$disconnect();
            await prisma.$connect();
            logger.debug("Database connection recovered");
        } catch (reconnectError) {
            logger.error("Failed to recover database connection:", reconnectError);
        }
    }
}, HEALTH_CHECK_INTERVAL);
