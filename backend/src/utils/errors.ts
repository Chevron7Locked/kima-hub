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

    // File system errors
    FILE_NOT_FOUND = "FILE_NOT_FOUND",
    FILE_READ_ERROR = "FILE_READ_ERROR",
    DISK_FULL = "DISK_FULL",
    PERMISSION_DENIED = "PERMISSION_DENIED",

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

/**
 * Check if an error is recoverable
 */
export function isRecoverable(error: any): boolean {
    if (error instanceof AppError) {
        return error.category === ErrorCategory.RECOVERABLE;
    }
    return false;
}

/**
 * Check if an error is transient
 */
export function isTransient(error: any): boolean {
    if (error instanceof AppError) {
        return error.category === ErrorCategory.TRANSIENT;
    }
    return false;
}

/**
 * Wrap a Node.js error in an AppError
 */
export function wrapNodeError(err: any, context: string): AppError {
    if (err.code === "ENOENT") {
        return new AppError(
            ErrorCode.FILE_NOT_FOUND,
            ErrorCategory.RECOVERABLE,
            `File not found: ${context}`,
            { originalError: err.message }
        );
    }

    if (err.code === "EACCES" || err.code === "EPERM") {
        return new AppError(
            ErrorCode.PERMISSION_DENIED,
            ErrorCategory.FATAL,
            `Permission denied: ${context}`,
            { originalError: err.message }
        );
    }

    if (err.code === "ENOSPC") {
        return new AppError(
            ErrorCode.DISK_FULL,
            ErrorCategory.TRANSIENT,
            `Disk full: ${context}`,
            { originalError: err.message }
        );
    }

    // Generic file read error
    return new AppError(
        ErrorCode.FILE_READ_ERROR,
        ErrorCategory.RECOVERABLE,
        `Failed to read file: ${context}`,
        { originalError: err.message }
    );
}

export class UserFacingError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code?: string
  ) {
    super(message);
    this.name = 'UserFacingError';
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
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfter?: number
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}
