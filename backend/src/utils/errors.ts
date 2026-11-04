import { Response } from "express";
import { logger } from "./logger";

/**
 * A thrown value as one log-safe string: an Error's stack, else String(value).
 * The value itself never reaches the logger (see safeError).
 */
function describeForLog(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? `${error.name}: ${error.message}`;
    }
    return String(error);
}

/**
 * Log the failure server-side and send the client a generic message. The error
 * is logged as a string: the logger's util.inspect would print an AxiosError's
 * config.headers, which on the connection-test routes carry unsaved API keys.
 */
export function safeError(res: Response, context: string, error: unknown, statusCode = 500): void {
    logger.error(`${context}: ${describeForLog(error)}`);
    res.status(statusCode).json({ error: "Internal server error" });
}

/**
 * Error categories for classification
 */
export enum ErrorCategory {
    RECOVERABLE = "RECOVERABLE", // Retry might succeed
    TRANSIENT = "TRANSIENT", // Temporary issue, will resolve
    FATAL = "FATAL", // Cannot continue
}

/**
 * Error codes for specific error types
 */
export enum ErrorCode {
    // Configuration errors
    MUSIC_PATH_NOT_ACCESSIBLE = "MUSIC_PATH_NOT_ACCESSIBLE",
    TRANSCODE_CACHE_NOT_WRITABLE = "TRANSCODE_CACHE_NOT_WRITABLE",
    FFMPEG_NOT_FOUND = "FFMPEG_NOT_FOUND",
    INVALID_CONFIG = "INVALID_CONFIG",

    // Transcoding errors
    TRANSCODE_FAILED = "TRANSCODE_FAILED",

    // Database errors
    DB_QUERY_ERROR = "DB_QUERY_ERROR",
}

/**
 * Custom application error class
 */
export class AppError extends Error {
    constructor(
        public code: ErrorCode,
        public category: ErrorCategory,
        message: string,
        public details?: any
    ) {
        super(message);
        this.name = "AppError";
        Object.setPrototypeOf(this, AppError.prototype);
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            category: this.category,
            message: this.message,
            details: this.details,
        };
    }
}

export class UserFacingError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code?: string
  ) {
    super(message);
    this.name = 'UserFacingError';
    Object.setPrototypeOf(this, UserFacingError.prototype);
  }
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    public integration: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'IntegrationError';
    Object.setPrototypeOf(this, IntegrationError.prototype);
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

/** Whether a filesystem error means the file is not there to read, rather than that reading it failed. */
export function isFileGone(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}
