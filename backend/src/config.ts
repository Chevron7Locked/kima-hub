import dotenv from "dotenv";
import fs from "fs";
import { z } from "zod";
import {
    validateMusicConfig,
    parseReconcileMode,
    MusicConfig,
} from "./utils/configValidator";
import { logger } from "./utils/logger";
import packageJson from "../package.json";

dotenv.config();

// Validate critical environment variables on startup
const envSchema = z.object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    SESSION_SECRET: z
        .string()
        .min(32, "SESSION_SECRET must be at least 32 characters"),
    PORT: z.string().optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).optional(),
    MUSIC_PATH: z.string().min(1, "MUSIC_PATH is required"),
});

try {
    envSchema.parse(process.env);
    logger.debug("Environment variables validated");
} catch (error) {
    if (error instanceof z.ZodError) {
        logger.error(" Environment validation failed:");
        error.issues.forEach((err) => {
            logger.error(`   - ${err.path.join(".")}: ${err.message}`);
        });
        logger.error(
            "\n Please check your .env file and ensure all required variables are set."
        );
        process.exit(1);
    }
}

// Music config - will be initialized async
let musicConfig: MusicConfig = {
    musicPath: process.env.MUSIC_PATH || "/music",
    transcodeCachePath:
        process.env.TRANSCODE_CACHE_PATH || "./cache/transcodes",
    transcodeCacheMaxGb: parseInt(
        process.env.TRANSCODE_CACHE_MAX_GB || "10",
        10
    ),
    reconcileMode: parseReconcileMode(process.env),
};

// Initialize music configuration asynchronously
export async function initializeMusicConfig() {
    try {
        musicConfig = { ...(await validateMusicConfig()), reconcileMode: musicConfig.reconcileMode };
        logger.debug("Music configuration initialized");
    } catch (err: any) {
        logger.error(" Configuration validation failed:", err.message);
        logger.warn("   Using default/environment configuration");
        // Don't exit process - allow app to start for other features
        // Music features will fail gracefully if config is invalid
    }
}

/** Whether the server's MUSIC_PATH fixes the music folder, so Settings cannot change it. */
export function musicPathFixedByEnv(): boolean {
    return !!process.env.MUSIC_PATH;
}

/** Why `folder` cannot be the music folder (missing, not a folder, unreadable), or null when it can. */
export function musicFolderProblem(folder: string): string | null {
    try {
        if (!fs.statSync(folder).isDirectory()) return `${folder} is not a folder`;
        fs.accessSync(folder, fs.constants.R_OK);
        return null;
    } catch (err: any) {
        return err?.code === "ENOENT" ? `${folder} does not exist on the server` : `${folder} cannot be read`;
    }
}

/** Makes `folder` the music folder at once, for scans, downloads, imports and Lidarr alike. */
export function useMusicFolder(folder: string): void {
    musicConfig = { ...musicConfig, musicPath: folder };
}

const PUBLIC_VIBE_TOKEN_MIN = 32;

// The /api/public/vibe surface exists only when KIMA_PUBLIC_VIBE=true and both
// its token and its user are set; otherwise the routes are never mounted.
function readPublicVibe(): { token: string; username: string } | null {
    if (process.env.KIMA_PUBLIC_VIBE !== "true") return null;
    const token = process.env.KIMA_PUBLIC_VIBE_TOKEN ?? "";
    const username = process.env.KIMA_PUBLIC_VIBE_USER?.trim() ?? "";
    if (token.length < PUBLIC_VIBE_TOKEN_MIN || !username) {
        logger.error(
            `KIMA_PUBLIC_VIBE is true but KIMA_PUBLIC_VIBE_TOKEN (at least ${PUBLIC_VIBE_TOKEN_MIN} characters) or KIMA_PUBLIC_VIBE_USER is missing; the public vibe routes stay off`
        );
        return null;
    }
    return { token, username };
}

export const APP_VERSION = packageJson.version;
export const USER_AGENT = `Kima/${APP_VERSION} (https://github.com/Chevron7Locked/kima-hub)`;

export const config = {
    version: APP_VERSION,
    port: parseInt(process.env.PORT || "3006", 10),
    nodeEnv: process.env.NODE_ENV || "development",
    // DATABASE_URL and REDIS_URL are validated by envSchema above, so they're guaranteed to exist
    databaseUrl: process.env.DATABASE_URL!,
    redisUrl: process.env.REDIS_URL!,
    sessionSecret: process.env.SESSION_SECRET!,

    // Music library configuration (self-contained native music system)
    // Access via config.music - will be updated after initialization
    get music() {
        return musicConfig;
    },

    // Lidarr from the environment; lidarrService.ensureInitialized() reads the database settings.
    lidarr:
        process.env.LIDARR_ENABLED === "true"
            ? {
                  url: process.env.LIDARR_URL!,
                  apiKey: process.env.LIDARR_API_KEY!,
                  enabled: true,
              }
            : undefined,

    // AcoustID - the shared opt-in client key baked in as a default so the
    // fingerprint-identification path works out of the box: operators are
    // expected to drop their own key in ACOUSTID_CLIENT_KEY to lift the
    // rate-limit ceiling. Safe to store in config (public, opt-in).
    acoustid: {
        clientKey: process.env.ACOUSTID_CLIENT_KEY || "JaLCkK9Xvt",
    },

    publicVibe: readPublicVibe(),

    allowedOrigins:
        process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ||
        (process.env.NODE_ENV === "development" ? true : []),

    // TCP keepalive idle delay. The OS reaps dead peers through failed probes
    // without cutting a paused audio stream, which an inactivity timeout would.
    socketKeepAliveDelayMs: parseInt(
        process.env.SOCKET_KEEPALIVE_DELAY_MS || "30000",
        10
    ),
};
