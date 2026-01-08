import dotenv from "dotenv";
import { z } from "zod";
import * as fs from "fs";
import { validateMusicConfig, MusicConfig } from "./utils/configValidator";
import { logger } from "./utils/logger";

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
        error.errors.forEach((err) => {
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
};

// Initialize music configuration asynchronously
export async function initializeMusicConfig() {
    try {
        musicConfig = await validateMusicConfig();
        logger.debug("Music configuration initialized");
    } catch (err: any) {
        logger.error(" Configuration validation failed:", err.message);
        logger.warn("   Using default/environment configuration");
        // Don't exit process - allow app to start for other features
        // Music features will fail gracefully if config is invalid
    }
}

export const config = {
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

    // Lidarr - now reads from database via lidarrService.ensureInitialized()
    lidarr:
        process.env.LIDARR_ENABLED === "true"
            ? {
                  url: process.env.LIDARR_URL!,
                  apiKey: process.env.LIDARR_API_KEY!,
                  enabled: true,
              }
            : undefined,

    // Last.fm - ships with default app key, user can optionally override
    lastfm: {
        apiKey: process.env.LASTFM_API_KEY || "95fe0eaa9875db7bb8539b2c738b4dcd",
    },

    // OpenAI - reads from database
    openai: {
        apiKey: process.env.OPENAI_API_KEY || "", // Fallback to DB
    },

    // Deezer - reads from database
    deezer: {
        apiKey: process.env.DEEZER_API_KEY || "", // Fallback to DB
    },

    audiobookshelf: process.env.AUDIOBOOKSHELF_URL
        ? {
              url: process.env.AUDIOBOOKSHELF_URL,
              token: process.env.AUDIOBOOKSHELF_TOKEN!,
          }
        : undefined,

    allowedOrigins:
        process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()) ||
        (process.env.NODE_ENV === "development" ? true : []),
};
