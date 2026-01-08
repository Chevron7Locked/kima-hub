type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

const currentLevel = (process.env.LOG_LEVEL as LogLevel) || 
    (process.env.NODE_ENV === 'production' ? 'warn' : 'debug');

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

export const logger = {
    debug: (message: string, ...args: any[]) => {
        if (shouldLog('debug')) {
            console.debug(`[DEBUG] ${message}`, ...args);
        }
    },
    info: (message: string, ...args: any[]) => {
        if (shouldLog('info')) {
            console.info(`[INFO] ${message}`, ...args);
        }
    },
    warn: (message: string, ...args: any[]) => {
        if (shouldLog('warn')) {
            console.warn(`[WARN] ${message}`, ...args);
        }
    },
    error: (message: string, ...args: any[]) => {
        if (shouldLog('error')) {
            console.error(`[ERROR] ${message}`, ...args);
        }
    },
};
