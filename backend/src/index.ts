import express from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { redisClient, waitForRedisReady } from "./utils/redis";
import { prisma } from "./utils/db";
import { logger } from "./utils/logger";

import { mountApi, mountQueueBoardSlot, QUEUE_BOARD_PATH } from "./routes/mounts";
import {
    checkEmbeddingWritePath,
    reportEmbeddingWritePathAtStartup,
} from "./services/embeddingsHealth";
import { lidarrHealthMonitor } from "./services/lidarrHealth";
import { combineAnalyzerStatus, heartbeatFresh } from "./utils/analyzerStatus";
import { errorHandler } from "./middleware/errorHandler";
import { resetAdminPassword } from "./services/users/accounts";
import { trustOneProxyHop } from "./middleware/rateLimiter";
import { jsonBodyParser } from "./middleware/jsonBody";
import { createShutdown } from "./shutdown";
import { closeSteps } from "./closeSteps";
import { runStartSteps, type StartStep } from "./startup";
import { createBackgroundStart } from "./backgroundStart";
import { useShutdownCheck } from "./utils/stopCheck";
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
                    logger.debug(
                        `[CORS] Origin ${origin} not in allowlist, rejecting`
                    );
                    callback(new Error("Not allowed by CORS"));
                }
            } else {
                // No restrictions - allow all (self-hosted default)
                callback(null, true);
            }
        },
        credentials: true,
    })
);
app.use(jsonBodyParser);

// Session
trustOneProxyHop(app);

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

// A beat older than this is a dead analyzer: CLAP beats every 30 s, MusiCNN every loop pass (1 to 5 s).
const ANALYZER_HEARTBEAT_WITHIN_MS = 120_000;

// Health check (keep at root for simple container health checks)
async function healthHandler(_req: express.Request, res: express.Response) {
    const checks: Record<string, string> = {};

    try {
        await prisma.$queryRaw`SELECT 1`;
        checks.db = "ok";
    } catch {
        checks.db = "error";
    }

    try {
        await redisClient.ping();
        checks.redis = "ok";
    } catch {
        checks.redis = "error";
    }

    // Reported but not part of the health verdict: a broken vibe engine or Lidarr
    // must not put the server into a 503 restart loop.
    const embeddingCheck = await checkEmbeddingWritePath();
    const lidarr = lidarrHealthMonitor.getState();

    // An analyzer is alive when it holds its Postgres connection (application_name) or its Redis heartbeat is fresh,
    // so a dead one (crash loop, gave up) still shows instead of hiding behind an all-ok. The heartbeat covers a
    // Postgres restart, after which the connections are gone until the analyzers next get work.
    const pgNames = new Set<string>();
    let pgKnown = true;
    try {
        const rows = await prisma.$queryRaw<Array<{ application_name: string }>>`
            SELECT DISTINCT application_name FROM pg_stat_activity
            WHERE datname = current_database() AND application_name IN ('audio-analyzer', 'clap-analyzer')`;
        for (const r of rows) pgNames.add(r.application_name);
    } catch {
        pgKnown = false;
    }
    const beat = async (key: string) => {
        try {
            return heartbeatFresh(await redisClient.get(key), Date.now(), ANALYZER_HEARTBEAT_WITHIN_MS);
        } catch {
            return false;
        }
    };
    const analysisAlive = pgNames.has("audio-analyzer") || (await beat("audio:worker:heartbeat"));
    const embeddingsAlive = pgNames.has("clap-analyzer") || (await beat("clap:worker:heartbeat"));
    const analyzers: string =
        // Without the connection list, only two fresh heartbeats are an answer.
        !pgKnown && !(analysisAlive && embeddingsAlive)
            ? "unknown"
            : combineAnalyzerStatus(analysisAlive, embeddingsAlive);

    const allOk = Object.values(checks).every((v) => v === "ok");
    res.status(allOk ? 200 : 503).json({
        status: allOk ? "ok" : "degraded",
        uptime: Math.floor(process.uptime()),
        version: config.version,
        ...checks,
        analyzers,
        // Codes only: this route needs no login, and the full reasons are in the log.
        embeddingWritePath: embeddingCheck.ok ? "ok" : "error",
        ...(embeddingCheck.ok ? {} : { embeddingWritePathReason: embeddingCheck.reason }),
        lidarr: lidarr.status,
    });
}

// Routes - All API routes prefixed with /api for clear separation from frontend
mountApi(app, { health: healthHandler, publicVibe: Boolean(config.publicVibe) });

// The queue dashboard takes its place here, though Bull Board is built later (once the workers have started), so the
// error handler below is still the last thing mounted and the dashboard's errors reach it.
const setQueueBoard = mountQueueBoardSlot(app);

// Error handler: last
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
        await waitForRedisReady();

        // Ready is necessary but not sufficient: ask for a round trip.
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
    await resetAdminPassword(resetPassword);
}

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

async function main() {
    // Verify database connections before accepting traffic
    await checkPostgresConnection();
    await checkRedisConnection();

    // Check for admin password reset
    await checkPasswordReset();

    // A stop signal during the checks above has already run the shutdown, which had no server to close: do not listen.
    if (gracefulShutdown.hasBegun()) return;

    const server = app.listen(config.port, "0.0.0.0", () => {
        httpServer = server;
        logger.debug(
            `Kima API running on port ${config.port} (accessible on all network interfaces)`
        );
        server.keepAliveTimeout = 65_000;  // > common LB idle of 60s
        server.headersTimeout = 70_000;    // must exceed keepAliveTimeout
        // No server.timeout: a paused audio stream is idle and would be cut. Dead
        // peers are reaped by TCP keepalive instead, which a live paused stream answers.
        server.timeout = 0;
        server.on("connection", (socket) => {
            socket.setKeepAlive(true, config.socketKeepAliveDelayMs);
        });

        // A stop signal can arrive while these run, so each is started only while no shutdown has begun.
        runStartSteps(listeningStartSteps, () => gracefulShutdown.hasBegun()).catch((err) =>
            logger.error("[STARTUP] Start steps failed:", err)
        );
    });
}

/** The catch-up work after start-up. The shutdown's drain waits for it (see ./backgroundStart). */
const background = createBackgroundStart(() => gracefulShutdown.hasBegun());

/** What the server starts once it is listening, in order (see ./startup). */
const listeningStartSteps: StartStep[] = [
    {
        name: "slow query monitoring",
        run: async () => {
            // Enable slow query monitoring in development
            if (config.nodeEnv === "development") {
                const { enableSlowQueryMonitoring } = await import("./utils/queryMonitor");
                enableSlowQueryMonitoring();
            }
        },
    },
    {
        name: "music configuration",
        run: async () => {
            // Initialize music configuration (reads from SystemSettings)
            const { initializeMusicConfig } = await import("./config");
            await initializeMusicConfig();
        },
    },
    {
        name: "library change marker",
        // Shown changes still waiting in their coalescing window when the last process stopped were forgotten with it,
        // so a client refetches once after every start.
        run: async () => {
            const { markLibraryChangedAtStart } = await import("./services/libraryChanged");
            await markLibraryChangedAtStart();
        },
    },
    {
        name: "GPU runtime projection",
        run: async () => {
            // Rewrite the GPU toggle file from the DB so the two cannot disagree after a restart.
            const { initGpuRuntimeProjection } = await import("./services/gpuRuntime");
            await initGpuRuntimeProjection();
        },
    },
    {
        name: "embedding write path check",
        // Verify that an audio embedding can actually be stored, and say so in the
        // log either way: the database, Redis and workers can all look healthy
        // while embeddings silently fail to write.
        run: () => reportEmbeddingWritePathAtStartup(),
    },
    {
        name: "public library export",
        run: async () => {
            // Build the public library export now, so its first request finds one.
            if (config.publicVibe) {
                const { latestLibraryExport } = await import("./services/publicLibraryExport");
                latestLibraryExport();
            }
        },
    },
    {
        name: "fpcalc check",
        run: async () => {
            // AcoustID fingerprinting is on only when fpcalc runs (fpcalcService warns when it does not).
            const { fpcalcService } = await import("./services/fpcalc");
            if (await fpcalcService.isAvailable()) {
                logger.info("[AcoustID] fpcalc found — fingerprint identification ENABLED");
            } else if (process.env.ACOUSTID_DISABLED === "true") {
                logger.info("[AcoustID] fingerprint identification turned off by ACOUSTID_DISABLED");
            }
        },
    },
    {
        name: "identity key repair",
        run: async () => {
            // Artist and album keys the July 2026 upgrade computed on a SQL_ASCII database (names outside English letters) are
            // corrected before any worker can scan and look those rows up by name.
            try {
                const { repairIdentityKeys } = await import("./services/identityKeyRepair");
                await repairIdentityKeys();
            } catch (err) {
                logger.error("[STARTUP] Correcting artist and album keys failed:", err);
            }
        },
    },
    {
        name: "workers",
        // Initialize BullMQ workers
        run: async () => void (await import("./workers")),
    },
    {
        name: "queue dashboard",
        run: async () => {
            // Set up Bull Board dashboard
            const { createBullBoard } = await import("@bull-board/api");
            const { BullMQAdapter } = await import("@bull-board/api/bullMQAdapter");
            const { ExpressAdapter } = await import("@bull-board/express");
            const { scanQueue, discoverQueue, importQueue } = await import("./workers/queues");
            const { artistQueue, trackQueue, vibeQueue, podcastQueue } = await import("./workers/enrichmentQueues");

            const serverAdapter = new ExpressAdapter();
            serverAdapter.setBasePath(QUEUE_BOARD_PATH);

            createBullBoard({
                queues: [
                    new BullMQAdapter(scanQueue),
                    new BullMQAdapter(discoverQueue),
                    new BullMQAdapter(importQueue),
                    new BullMQAdapter(artistQueue),
                    new BullMQAdapter(trackQueue),
                    new BullMQAdapter(vibeQueue),
                    new BullMQAdapter(podcastQueue),
                ],
                serverAdapter,
            });

            setQueueBoard(serverAdapter.getRouter());
            logger.debug("Bull Board dashboard available at /api/admin/queues (admin-only)");
        },
    },
    {
        name: "cache warmup",
        run: () => {
            // No automatic sync on startup: library scanning is triggered manually via POST /library/scan.

            // Enrichment worker enabled for OWNED content only
            // - Background enrichment: Genres, MBIDs, similar artists for owned albums/artists
            // - On-demand fetching: Artist images, bios when browsing (cached in Redis 7 days)
            logger.debug("Background enrichment enabled for owned content (genres, MBIDs, etc.)");

            // Warm up Redis cache from database on startup, without holding up the steps after it.
            background.startCacheWarmup();
        },
    },
    {
        name: "webhook reconciliation and Lidarr health",
        run: async () => {
            const { webhookReconciliation } = await import("./jobs/webhookReconciliation");
            if (gracefulShutdown.hasBegun()) return; // the import can outlast a stop signal
            webhookReconciliation.start();
            lidarrHealthMonitor.start();
        },
    },
    {
        name: "webhook event cleanup",
        run: async () => {
            // Webhook event cleanup - runs daily to remove old processed events
            const { webhookEventStore } = await import("./services/webhookEventStore");
            if (gracefulShutdown.hasBegun()) return; // the import can outlast a stop signal

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
        },
    },
    {
        name: "podcast cache cleanup",
        run: async () => {
            // Podcast cache cleanup - runs daily to remove cached episodes older than 30 days
            const { cleanupExpiredCache, measureCachedEpisodeLengths } = await import("./services/podcastDownload");
            if (gracefulShutdown.hasBegun()) return; // the import can outlast a stop signal

            // Run cleanup on startup (async, don't block), then measure what stays cached.
            cleanupExpiredCache()
                .catch((err) => {
                    logger.error("Podcast cache cleanup failed:", err);
                })
                .then(() => measureCachedEpisodeLengths())
                .catch((err) => {
                    logger.error("Measuring cached podcast episode lengths failed:", err);
                });
            import("./services/podcastCatalog")
                .then(({ assignMissingCategories }) => assignMissingCategories())
                .catch((err) => {
                    logger.error("Filling podcast categories failed:", err);
                });

            // Schedule daily cleanup (every 24 hours)
            podcastCleanupInterval = setInterval(() => {
                cleanupExpiredCache().catch((err) => {
                    logger.error("Scheduled podcast cache cleanup failed:", err);
                });
            }, TWENTY_FOUR_HOURS);
            logger.debug("Podcast cache cleanup scheduled (daily, 30-day expiry)");
        },
    },
    ...background.steps,
];

// Graceful shutdown handling
let httpServer: ReturnType<typeof app.listen> | undefined;
let healthCheckInterval: NodeJS.Timeout | null = null;
let podcastCleanupInterval: NodeJS.Timeout | null = null;
let webhookCleanupInterval: NodeJS.Timeout | null = null;

/**
 * Longest a shutdown may take before the process exits anyway (code 1). It covers the 3 s drain below, with room for
 * the workers, Redis and the database to close, and ends before Docker's default 10 s stop timeout sends SIGKILL, so
 * the log says the shutdown stalled instead of the process vanishing without a word. `tsx watch` waits for the old process to exit before it starts the next, so a shutdown
 * that stalled would otherwise hang a restart for good.
 */
const SHUTDOWN_DEADLINE_MS = 8_000;

const gracefulShutdown = createShutdown({
    // Nothing new starts while the rest drains: no new connections, no new reconciliation cycle or event, no new
    // health check or cleanup run. The listener is not waited for: an open stream or event connection would hold it.
    stopAccepting: [
        () => {
            httpServer?.close();
            httpServer?.closeIdleConnections();
        },
        async () => {
            const { webhookReconciliation } = await import("./jobs/webhookReconciliation");
            webhookReconciliation.stop();
        },
        async () => {
            const { stopWebhookProcessing } = await import("./services/webhookHandlers");
            stopWebhookProcessing();
        },
        () => lidarrHealthMonitor.stop(),
        () => {
            if (healthCheckInterval) clearInterval(healthCheckInterval);
            if (podcastCleanupInterval) clearInterval(podcastCleanupInterval);
            if (webhookCleanupInterval) clearInterval(webhookCleanupInterval);
        },
    ],
    // Let the batch and import checks a settled download job started, and the webhook events being processed,
    // finish while the queues and the database are still open. One waiting on Lidarr for a minute is not held for:
    // both wait together for the same moment. A webhook event left unfinished is replayed by the reconciliation job
    // on the next start. The start-up catch-up work (cache warmup, audiobook sync, artist counts, image backfill) is
    // waited for too: the batch under way finishes, the next never starts, and the wait ends at the deadline.
    drain: async () => {
        const { whenIdle } = await import("./services/downloads/jobs");
        const { whenWebhooksIdle } = await import("./services/webhookHandlers");
        await Promise.all([whenIdle(3000), whenWebhooksIdle(3000), background.whenEnded()]);
    },
    close: closeSteps,
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    exit: (code) => process.exit(code),
});

// Work a request starts (an admin backfill, a re-file) stops between batches once this shutdown has begun.
useShutdownCheck(gracefulShutdown.hasBegun);

// Handle termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Global error handlers to prevent silent crashes
process.on("unhandledRejection", (reason, _promise) => {
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
    gracefulShutdown("uncaughtException", { failed: true }).catch(() => {
        process.exit(1);
    });
});

// Periodic health check to keep database connections alive and detect issues early
// Runs every 5 minutes to prevent idle connection drops
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;
healthCheckInterval = setInterval(async () => {
    if (gracefulShutdown.hasBegun()) return;
    try {
        // Ping PostgreSQL
        await prisma.$queryRaw`SELECT 1`;

        // Ping Redis
        if (redisClient.status === "ready") {
            await redisClient.ping();
        }
    } catch (error) {
        // A check that failed because the connections were closing is no stale connection: reconnecting would reopen
        // the database after the shutdown closed it.
        if (gracefulShutdown.hasBegun()) return;
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

// Last, so everything the start-up reads (the shutdown, the start steps, the intervals) is declared before it runs.
main().catch((err) => {
    logger.error("Server failed to start:", err);
    process.exit(1);
});
