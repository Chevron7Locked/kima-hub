import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { logger } from "../utils/logger";
import { AppError, ErrorCategory, UserFacingError } from "../utils/errors";
import { config } from "../config";

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction
) {
    // Once the response has started no status can be sent; an audio stream can
    // fail long after its headers went out. Express's default handler closes the
    // connection, which is the only signal left.
    if (res.headersSent) {
        logger.error(`Error after response started (${req.method} ${req.path}):`, err.message);
        return next(err);
    }

    // Handle AppError with proper categorization
    if (err instanceof AppError) {
        // Map error category to HTTP status code
        let statusCode = 500;
        switch (err.category) {
            case ErrorCategory.RECOVERABLE:
                statusCode = 400; // Bad Request - client can retry with changes
                break;
            case ErrorCategory.TRANSIENT:
                statusCode = 503; // Service Unavailable - client can retry later
                break;
            case ErrorCategory.FATAL:
                statusCode = 500; // Internal Server Error - cannot recover
                break;
        }

        logger.error(`[AppError] ${err.code}: ${err.message}`, err.details);

        return res.status(statusCode).json({
            error: err.message,
            code: err.code,
            category: err.category,
            ...(config.nodeEnv === "development" && { details: err.details }),
        });
    }

    // A UserFacingError carries its own status and a message written for the
    // client, returned in production too. Text not safe to show stays a plain
    // Error, hidden below.
    if (err instanceof UserFacingError) {
        // A 4xx is the client's problem, not a server fault. Logging 95 "album
        // not found"s a day at error level buries the ones that matter.
        const log = err.statusCode >= 500 ? logger.error : logger.warn;
        log(`[UserFacingError] ${err.statusCode} ${req.method} ${req.path}: ${err.message}`);

        return res.status(err.statusCode).json({
            error: err.message,
            ...(err.code && { code: err.code }),
        });
    }

    // A failed Zod parse is a bad request: 400 with the issues.
    if (err instanceof ZodError) {
        logger.warn(`[ZodError] ${req.method} ${req.path}: ${err.issues.length} issue(s)`);

        return res.status(400).json({
            error: "Invalid request",
            details: err.issues,
        });
    }

    // A request body that cannot be read (bad JSON, too large) is the client's error.
    const bodyError = err as Error & { type?: unknown; status?: unknown };
    if (typeof bodyError.type === "string" && bodyError.type.startsWith("entity.")
        && typeof bodyError.status === "number" && bodyError.status >= 400 && bodyError.status < 500) {
        logger.warn(`[BodyParser] ${req.method} ${req.path}: ${bodyError.type}`);
        return res.status(bodyError.status).json({
            error: bodyError.status === 413 ? "Request body too large" : "Invalid request body",
        });
    }

    // Log stack trace for unhandled errors
    logger.error("Unhandled error:", err.stack);

    // In production, hide stack traces and internal details
    if (config.nodeEnv === "production") {
        return res.status(500).json({ error: "Internal server error" });
    }

    // In development, provide more details
    res.status(500).json({
        error: err.message || "Internal server error",
        stack: err.stack,
    });
}
