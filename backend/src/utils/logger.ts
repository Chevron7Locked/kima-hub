type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};

const defaultLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'debug';
const rawLevel = process.env.LOG_LEVEL;
const requestedLevel = rawLevel?.trim().toLowerCase() ?? '';
const isKnownLevel = Object.hasOwn(LOG_LEVELS, requestedLevel);
const currentLevel: LogLevel = isKnownLevel
    ? (requestedLevel as LogLevel)
    : defaultLevel;

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/** A failed HTTP request logged as one line: printed whole, an axios error is the
 * entire request and socket. The query string is left out: some sources take their
 * key in it. */
function describe(arg: unknown): unknown {
    const err = arg as {
        isAxiosError?: boolean;
        message?: string;
        code?: string;
        response?: { status?: number };
        config?: { method?: string; baseURL?: string; url?: string };
    } | null;
    if (!err || err.isAxiosError !== true) return arg;
    const url = `${err.config?.baseURL ?? ""}${err.config?.url ?? ""}`.split("?")[0];
    const status = err.response?.status ?? err.code ?? "no response";
    return `${err.message} (${status}, ${(err.config?.method ?? "get").toUpperCase()} ${url})`;
}

export const logger = {
    debug: (message: string, ...args: any[]) => {
        if (shouldLog('debug')) {
            console.debug(`[DEBUG] ${message}`, ...args.map(describe));
        }
    },
    info: (message: string, ...args: any[]) => {
        if (shouldLog('info')) {
            console.info(`[INFO] ${message}`, ...args.map(describe));
        }
    },
    warn: (message: string, ...args: any[]) => {
        if (shouldLog('warn')) {
            console.warn(`[WARN] ${message}`, ...args.map(describe));
        }
    },
    error: (message: string, ...args: any[]) => {
        if (shouldLog('error')) {
            console.error(`[ERROR] ${message}`, ...args.map(describe));
        }
    },
};

if (requestedLevel && !isKnownLevel) {
    logger.warn(
        `LOG_LEVEL "${rawLevel}" is not one of ${Object.keys(LOG_LEVELS).join(", ")}; logging at "${defaultLevel}"`,
    );
}
