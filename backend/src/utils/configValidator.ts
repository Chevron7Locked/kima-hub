import * as fs from "fs";
import { logger } from "./logger";
import * as path from "path";
import { execSync } from "child_process";
import { AppError, ErrorCode, ErrorCategory } from "./errors";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { getSystemSettings } from "./systemSettings";

export interface MusicConfig {
    musicPath: string;
    transcodeCachePath: string;
    transcodeCacheMaxGb: number;
}

/**
 * Validate and load music configuration
 */
export async function validateMusicConfig(): Promise<MusicConfig> {
    // Get system settings to use configured paths
    const settings = await getSystemSettings();

    // Priority: Environment variable > Database setting > Default
    // Env var takes precedence to support Docker deployments where mount point is fixed
    let musicPath = process.env.MUSIC_PATH || settings?.musicPath || "/music";

    // Docker safety: If configured path doesn't exist but /music does, use /music
    // This handles users passing host .env files to Docker with host paths
    const isDocker = fs.existsSync('/.dockerenv');
    if (isDocker && !fs.existsSync(musicPath) && fs.existsSync('/music')) {
        logger.warn(`MUSIC_PATH=${musicPath} not found in container, using /music (Docker mount point)`);
        musicPath = '/music';
    }

    // Log if database has a different path than what we're using (helps debug migrations)
    if (settings?.musicPath && settings.musicPath !== musicPath) {
        logger.debug(`Database has musicPath=${settings.musicPath}, using ${musicPath} from env/default`);
    }

    // VALIDATE MUSIC PATH EXISTS
    if (!fs.existsSync(musicPath)) {
        const isDocker = fs.existsSync('/.dockerenv') || process.env.NODE_ENV === 'production';
        const guidance = isDocker
            ? `Docker users: Ensure your volume mount is correct in docker-compose.yml:
   volumes:
     - /path/to/your/music:/music
   The container expects music at /music, not your host path.`
            : `Check that MUSIC_PATH in your .env file points to an existing directory.`;
        
        throw new AppError(
            ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            ErrorCategory.FATAL,
            `Music path does not exist: ${musicPath}\n\n${guidance}`
        );
    }

    // VALIDATE MUSIC PATH IS READABLE
    try {
        fs.accessSync(musicPath, fs.constants.R_OK);
    } catch {
        throw new AppError(
            ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            ErrorCategory.FATAL,
            `Music path not readable: ${musicPath}. Check file permissions.`
        );
    }

    // Get transcode cache path
    const transcodeCachePath =
        process.env.TRANSCODE_CACHE_PATH ||
        path.join(process.cwd(), "cache", "transcodes");

    // VALIDATE TRANSCODE CACHE PATH
    // Create if doesn't exist
    if (!fs.existsSync(transcodeCachePath)) {
        try {
            fs.mkdirSync(transcodeCachePath, { recursive: true });
            logger.debug(
                `Created transcode cache directory: ${transcodeCachePath}`
            );
        } catch (err: any) {
            throw new AppError(
                ErrorCode.TRANSCODE_CACHE_NOT_WRITABLE,
                ErrorCategory.FATAL,
                `Cannot create transcode cache directory: ${transcodeCachePath}`,
                { originalError: err.message }
            );
        }
    }

    // Validate writable
    try {
        fs.accessSync(transcodeCachePath, fs.constants.W_OK);
    } catch {
        throw new AppError(
            ErrorCode.TRANSCODE_CACHE_NOT_WRITABLE,
            ErrorCategory.FATAL,
            `Transcode cache not writable: ${transcodeCachePath}. Check file permissions.`
        );
    }

    // Get cache size limit from SystemSettings or fallback to env/default
    const transcodeCacheMaxGb =
        settings?.transcodeCacheMaxGb ||
        parseInt(process.env.TRANSCODE_CACHE_MAX_GB || "10", 10);

    if (isNaN(transcodeCacheMaxGb) || transcodeCacheMaxGb < 1) {
        throw new AppError(
            ErrorCode.INVALID_CONFIG,
            ErrorCategory.FATAL,
            `Invalid transcode cache size: must be a positive integer. Got: ${transcodeCacheMaxGb}`
        );
    }

    // VALIDATE BUNDLED FFMPEG (from @ffmpeg-installer/ffmpeg)
    try {
        // Check if bundled FFmpeg binary exists
        if (!fs.existsSync(ffmpegPath.path)) {
            throw new Error(`Bundled FFmpeg not found at: ${ffmpegPath.path}`);
        }

        // Verify it's executable by running version check
        const result = execSync(`"${ffmpegPath.path}" -version`, {
            encoding: "utf8",
        });
        if (!result.includes("ffmpeg version")) {
            throw new Error("Invalid ffmpeg output");
        }

        logger.debug(`FFmpeg detected (bundled): ${result.split("\n")[0]}`);
        logger.debug(`   FFmpeg path: ${ffmpegPath.path}`);
    } catch (err: any) {
        logger.warn(
            "  Bundled FFmpeg not available. Transcoding will not be available."
        );
        logger.warn(`   Error: ${err.message}`);
        logger.warn("   Original quality streaming will still work.");
        // Don't throw - allow server to start without FFmpeg
    }

    logger.debug("Music configuration validated successfully");
    logger.debug(`   Music path: ${musicPath}`);
    logger.debug(`   Transcode cache: ${transcodeCachePath}`);
    logger.debug(`   Cache limit: ${transcodeCacheMaxGb} GB`);

    return {
        musicPath,
        transcodeCachePath,
        transcodeCacheMaxGb,
    };
}
