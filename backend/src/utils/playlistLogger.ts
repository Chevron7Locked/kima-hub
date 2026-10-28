import * as fs from 'fs';
import { logger } from "./logger";
import * as path from 'path';

/**
 * Log files for Spotify import and playlist work, under ./logs/playlists or
 * PLAYLIST_LOG_DIR: import_<jobId>_<timestamp>.log per job, and session.log,
 * cleared on each start.
 */

const LOGS_DIR = process.env.PLAYLIST_LOG_DIR
    ? path.resolve(process.env.PLAYLIST_LOG_DIR)
    : path.join(process.cwd(), 'logs', 'playlists');
const SESSION_LOG = path.join(LOGS_DIR, 'session.log');

// Clear session log on module load (fresh start)
let sessionInitialized = false;

// Ensure logs directory exists
function ensureLogsDir(): void {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (error) {
        logger.error('Failed to create playlist logs directory:', {
            logsDir: LOGS_DIR,
            error,
        });
    }
}

// Initialize session log (clear previous session)
function initSessionLog(): void {
    if (sessionInitialized) return;
    sessionInitialized = true;
    ensureLogsDir();

    const header = `
================================================================================
  SPOTIFY IMPORT SESSION LOG
  Started: ${new Date().toISOString()}
================================================================================

`;
    fs.promises.writeFile(SESSION_LOG, header).catch((error) => {
        logger.error('Failed to initialize session log:', error);
    });
}

// Write to session log (unified log for all components)
function writeToSessionLog(component: string, level: string, message: string): void {
    initSessionLog();
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const line = `[${timestamp}] [${component}] [${level}] ${message}\n`;

    fs.promises.appendFile(SESSION_LOG, line).catch(() => {
        // Silently fail - don't spam console
    });
}

/**
 * Log a message from any component to the unified session log
 * Use this for Soulseek, organize, etc.
 */
export function sessionLog(component: string, message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO'): void {
    writeToSessionLog(component, level, message);

    // Also log to console with component prefix
    const prefix = `[${component}]`;
    if (level === 'ERROR') {
        logger.error(prefix, message);
    } else {
        logger.debug(prefix, message);
    }
}

function getTimestamp(): string {
    return new Date().toISOString();
}

function formatLogLine(level: string, message: string): string {
    return `[${getTimestamp()}] [${level}] ${message}\n`;
}

class PlaylistLogger {
    private logFile: string;

    constructor(jobId: string) {
        ensureLogsDir();
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.logFile = path.join(LOGS_DIR, `import_${jobId}_${timestamp}.log`);
        
        // Write header
        this.write('INFO', `=== SPOTIFY IMPORT JOB: ${jobId} ===`);
    }

    private write(level: string, message: string): void {
        // Write to unified session log
        writeToSessionLog('IMPORT', level, message);

        // Also log to console
        if (level === 'ERROR') {
            logger.error(`[Playlist Logger] ${message}`);
        } else {
            logger.debug(`[Playlist Logger] ${message}`);
        }

        fs.promises.appendFile(this.logFile, formatLogLine(level, message)).catch((error) => {
            logger.error(`[Playlist Logger] Failed to write to ${this.logFile}:`, error);
        });
    }

    info(message: string): void {
        this.write('INFO', message);
    }

    error(message: string): void {
        this.write('ERROR', message);
    }

    warn(message: string): void {
        this.write('WARN', message);
    }

    debug(message: string): void {
        this.write('DEBUG', message);
    }

    log(message: string): void {
        this.write('INFO', message);
    }

    // Structured logging methods
    logJobStart(playlistName: string, trackCount: number, userId: string): void {
        this.info(`Playlist: "${playlistName}" (${trackCount} tracks)`);
        this.info(`User: ${userId}`);
        this.info('');
    }

    logTrackMatchingStart(): void {
        this.info('--- TRACK MATCHING ---');
    }

    logTrackMatch(
        index: number, 
        total: number, 
        title: string, 
        artist: string, 
        matched: boolean, 
        matchedTrackId?: string
    ): void {
        const status = matched ? '✓' : '✗';
        const result = matched 
            ? `MATCHED -> ${matchedTrackId}` 
            : 'NOT FOUND';
        this.info(`[${index}/${total}] ${status} "${title}" by ${artist} - ${result}`);
    }

    logAlbumDownloadStart(count: number): void {
        this.info('');
        this.info('--- ALBUM DOWNLOADS ---');
        this.info(`Requesting ${count} album(s) from Lidarr`);
    }

    logAlbumFailed(albumName: string, artistName: string, reason: string): void {
        this.error(`✗ Failed: "${albumName}" by ${artistName} - ${reason}`);
    }

    logDownloadProgress(completed: number, failed: number, pending: number): void {
        this.info(`Download status: ${completed} completed, ${failed} failed, ${pending} pending`);
    }

    logPlaylistCreationStart(): void {
        this.info('');
        this.info('--- PLAYLIST CREATION ---');
    }

    logPlaylistCreated(playlistId: string, trackCount: number, totalTracks: number): void {
        this.info(`Created playlist: ${playlistId}`);
        this.info(`Tracks added: ${trackCount}/${totalTracks}`);
    }

    logJobComplete(tracksMatched: number, tracksTotal: number, playlistId: string | null): void {
        this.info('');
        this.info('=== JOB COMPLETE ===');
        this.info(`Final result: ${tracksMatched}/${tracksTotal} tracks matched`);
        if (playlistId) {
            this.info(`Playlist ID: ${playlistId}`);
        }
        this.info(`Log file: ${this.logFile}`);
    }
}

// Factory function to create loggers
export function createPlaylistLogger(jobId: string): PlaylistLogger {
    return new PlaylistLogger(jobId);
}

