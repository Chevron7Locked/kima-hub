import type { Response } from "express";
import { logger } from "./logger";

/**
 * Sends a stored file. A file that cannot be sent (deleted between the caller's check and the send, say) is answered by
 * `onFailure`, never left to Express's default handler, unless the answer has already started: then the connection
 * is simply left as it is.
 */
export function sendStoredFile(
    res: Response,
    file: string,
    options: { headers?: Record<string, string> },
    onFailure: () => void,
): void {
    res.sendFile(file, options, (err) => {
        if (!err || res.headersSent) return;
        // A client that hung up first has nobody left to answer.
        const code = (err as NodeJS.ErrnoException).code;
        if (res.destroyed || code === "ECONNABORTED" || code === "EPIPE" || err.message === "Request aborted") return;
        logger.warn(`[sendStoredFile] ${file} could not be sent: ${err.message}`);
        onFailure();
    });
}
