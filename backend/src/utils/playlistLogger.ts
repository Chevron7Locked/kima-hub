import * as fs from 'fs';
import { logger } from "./logger";
import * as path from 'path';

/**
 * Log files for Spotify import and playlist work, under ./logs/playlists or
 * PLAYLIST_LOG_DIR: import_<jobId>_<timestamp>.log per job, and session.log, cleared by the process's first write to it.
 */

const LOGS_DIR = process.env.PLAYLIST_LOG_DIR
    ? path.resolve(process.env.PLAYLIST_LOG_DIR)
    : path.join(process.cwd(), 'logs', 'playlists');
const SESSION_LOG = path.join(LOGS_DIR, 'session.log');

let sessionInitialized = false;

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

/** Starts session.log over, once per process. */
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

function writeToSessionLog(component: string, level: string, message: string): void {
    initSessionLog();
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const line = `[${timestamp}] [${component}] [${level}] ${message}\n`;

    // A log line that cannot be written is dropped quietly, so a full disk does not flood the console.
    fs.promises.appendFile(SESSION_LOG, line).catch(() => {});
}

/** A line in session.log from any component (Soulseek, organizing), echoed to the console log. */
export function sessionLog(component: string, message: string, level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO'): void {
    writeToSessionLog(component, level, message);

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
        this.write('INFO', `=== SPOTIFY IMPORT JOB: ${jobId} ===`);
    }

    private write(level: string, message: string): void {
        writeToSessionLog('IMPORT', level, message);
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

