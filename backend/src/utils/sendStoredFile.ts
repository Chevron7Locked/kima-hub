import type { Response } from "express";
import { logger } from "./logger";

/**
 * Sends a stored file. A file that cannot be sent (deleted between the caller's check and the send, say) is answered by
 * `whenMissing`, never left to Express's default handler, unless the answer has already started: then the connection
 * is simply left as it is.
 */
export function sendStoredFile(
    res: Response,
    file: string,
    options: { headers?: Record<string, string> },
    whenMissing: () => void,
): void {
    res.sendFile(file, options, (err) => {
        if (!err || res.headersSent) return;
        logger.warn(`[sendStoredFile] ${file} could not be sent: ${err.message}`);
        whenMissing();
    });
}
