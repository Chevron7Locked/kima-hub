import { Request, Response } from "express";
import type { ZodError } from "zod";
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

const MAX_LOGGED_ISSUES = 5;
const MAX_LOGGED_ISSUE_CHARS = 500;

/**
 * Answer a request that did not parse: a plain 400 that says nothing of the schema, and the issues in the log for
 * whoever runs the server. The path is baseUrl + path, never originalUrl, which can carry a token in its query.
 */
export function invalidRequest(req: Request, res: Response, error: ZodError): Response {
    // A client picks the keys in an issue's path and can send thousands of bad items: the line shows the first few,
    // on one line, and stops at a fixed length.
    const shown = error.issues
        .slice(0, MAX_LOGGED_ISSUES)
        .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
        .join("; ");
    const more = error.issues.length > MAX_LOGGED_ISSUES ? ` (+${error.issues.length - MAX_LOGGED_ISSUES} more)` : "";
    const line = `${shown}${more}`.replace(/[\r\n\t]+/g, " ");
    const clipped = line.length > MAX_LOGGED_ISSUE_CHARS ? `${line.slice(0, MAX_LOGGED_ISSUE_CHARS)}...` : line;
    logger.warn(`[InvalidRequest] ${req.method} ${req.baseUrl}${req.path}: ${clipped}`);
    return res.status(400).json({ error: "Invalid request" });
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
