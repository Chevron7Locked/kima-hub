import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { AppError, ErrorCategory, UserFacingError } from "../utils/errors";
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

    // A UserFacingError names its own status and says something the client is
    // meant to read. Both matter: `AppError`'s three categories only reach 400,
    // 503 and 500, so before this branch existed there was no way to THROW a
    // 404 -- it fell through to the generic case below and became a 500 whose
    // message was replaced with "Internal server error". Measured against this
    // file before the branch was added:
    //
    //     throw new UserFacingError("Album not found", 404)
    //       -> HTTP 500 {"error":"Internal server error"}
    //
    // That is why the route files answer with `res.status(404)` by hand 95
    // times: throwing could not express it. This branch is what makes those
    // rewritable.
    //
    // The message is returned in production as well as development, which is
    // the entire distinction the class draws -- "user-facing" means the text
    // was written for the client. Anything whose text is NOT safe to show has
    // no business being a UserFacingError, and stays a plain Error, which the
    // generic branch below keeps hiding in production.
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
