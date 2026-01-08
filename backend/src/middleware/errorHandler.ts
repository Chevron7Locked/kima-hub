import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { AppError, ErrorCategory } from "../utils/errors";
import { config } from "../config";

export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction
) {
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
