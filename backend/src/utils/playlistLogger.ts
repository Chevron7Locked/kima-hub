import * as fs from 'fs';
import { logger } from "./logger";
import * as path from 'path';

/**
 * Dedicated logger for Spotify Import and Playlist operations.
 *
 * In Docker, the backend runs under /app and typically mounts /app/logs.
 * This logger defaults to writing under ./logs/playlists (relative to process.cwd()).
 *
 * Override with PLAYLIST_LOG_DIR if you want a different location.
 *
 * Log files:
 * - import_<jobId>_<timestamp>.log - Per-job detailed log
 * - session.log - Current session unified log (cleared on restart)
 * - events.log - Persistent event log
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
    try {
        fs.writeFileSync(SESSION_LOG, header);
    } catch (error) {
        logger.error('Failed to initialize session log:', error);
    }
}

// Write to session log (unified log for all components)
function writeToSessionLog(component: string, level: string, message: string): void {
    initSessionLog();
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const line = `[${timestamp}] [${component}] [${level}] ${message}\n`;

    try {
        fs.appendFileSync(SESSION_LOG, line);
    } catch (error) {
        // Silently fail - don't spam console
    }
}

/**
 * Get the path to the current session log
 */
export function getSessionLogPath(): string {
    ensureLogsDir();
    return SESSION_LOG;
}

/**
 * Read the current session log contents
 */
export function readSessionLog(): string {
    try {
        if (fs.existsSync(SESSION_LOG)) {
            return fs.readFileSync(SESSION_LOG, 'utf-8');
        }
        return 'No session log found';
    } catch (error) {
        return `Error reading session log: ${error}`;
    }
}

/**
 * Log a message from any component to the unified session log
 * Use this for SLSKD, organize, etc.
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
    private jobId: string;
    private logFile: string;
    private buffer: string[] = [];

    constructor(jobId: string) {
        this.jobId = jobId;
        ensureLogsDir();
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.logFile = path.join(LOGS_DIR, `import_${jobId}_${timestamp}.log`);
        
        // Write header
        this.write('INFO', `=== SPOTIFY IMPORT JOB: ${jobId} ===`);
    }

    private write(level: string, message: string): void {
        const line = formatLogLine(level, message);
        this.buffer.push(line);

        // Write to unified session log
        writeToSessionLog('IMPORT', level, message);

        // Also log to console
        if (level === 'ERROR') {
            logger.error(`[Playlist Logger] ${message}`);
        } else {
            logger.debug(`[Playlist Logger] ${message}`);
        }

        // Flush to file
        this.flush();
    }

    private flush(): void {
        try {
            fs.appendFileSync(this.logFile, this.buffer.join(''));
            this.buffer = [];
        } catch (error) {
            logger.error(`[Playlist Logger] Failed to write to ${this.logFile}:`, error);
        }
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

    // Alias for info - used for generic logging
    log(message: string): void {
        this.write('DEBUG', message);
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

    logAlbumQueued(albumName: string, artistName: string, mbid: string, lidarrId?: number): void {
        const lidarrInfo = lidarrId ? ` (Lidarr ID: ${lidarrId})` : '';
        this.info(`✓ Queued: "${albumName}" by ${artistName} [MBID: ${mbid}]${lidarrInfo}`);
    }

    logAlbumFailed(albumName: string, artistName: string, reason: string): void {
        this.error(`✗ Failed: "${albumName}" by ${artistName} - ${reason}`);
    }

    logSlskdFallbackStart(albumName: string, artistName: string): void {
        this.info('');
        this.info('--- SOULSEEK FALLBACK ---');
        this.info(`Trying Soulseek for: "${albumName}" by ${artistName}`);
    }

    logSlskdSearchResult(found: boolean, quality?: string, username?: string, trackCount?: number, sizeMB?: number): void {
        if (found) {
            this.info(`✓ Soulseek match: ${quality} from ${username} (${trackCount} tracks, ${sizeMB}MB)`);
        } else {
            this.info(`✗ Soulseek: No suitable results found`);
        }
    }

    logSlskdDownloadQueued(filesQueued: number, username: string): void {
        this.info(`✓ Soulseek: Queued ${filesQueued} files from ${username}`);
    }

    logSlskdDownloadFailed(reason: string): void {
        this.error(`✗ Soulseek download failed: ${reason}`);
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

    logJobFailed(error: string): void {
        this.info('');
        this.error('=== JOB FAILED ===');
        this.error(error);
        this.error(`Log file: ${this.logFile}`);
    }

    getLogFilePath(): string {
        return this.logFile;
    }
}

// Factory function to create loggers
export function createPlaylistLogger(jobId: string): PlaylistLogger {
    return new PlaylistLogger(jobId);
}

// Quick console+file log for one-off messages
export function logPlaylistEvent(message: string): void {
    ensureLogsDir();
    const line = formatLogLine('INFO', message);
    const eventsFile = path.join(LOGS_DIR, 'events.log');
    
    logger.debug(`[Playlist] ${message}`);
    
    try {
        fs.appendFileSync(eventsFile, line);
    } catch (error) {
        logger.error(`Failed to write to events log:`, error);
    }
}

