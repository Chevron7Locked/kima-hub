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

    // A failed `schema.parse()` is the client sending the wrong thing, which is
    // a 400 -- but ZodError is not an AppError, so without this branch it fell
    // through to the generic case and became a 500. That is why every route
    // using Zod hand-catches it:
    //
    //     if (error instanceof z.ZodError) {
    //         return res.status(400).json({ error: "Invalid request", details: error.errors });
    //     }
    //
    // repeated in plays, settings, systemSettings, listeningState, offline and
    // playlistImport. The sweep's instruction to "validate input with Zod" is
    // only safe once this exists; validating and letting it throw would have
    // answered 500 to a bad query string.
    //
    // This is deliberately ADDITIVE. The existing hand-catches still run first
    // and keep their own wording ("Invalid settings"), so no current response
    // changes. They become deletable as each route is rewritten, not before.
    if (err instanceof ZodError) {
        logger.warn(`[ZodError] ${req.method} ${req.path}: ${err.errors.length} issue(s)`);

        return res.status(400).json({
            error: "Invalid request",
            details: err.errors,
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
