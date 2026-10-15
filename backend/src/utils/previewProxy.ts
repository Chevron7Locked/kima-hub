import axios from "axios";
import type { Response } from "express";
import { logger } from "./logger";
import { upstreamHeader } from "./upstreamHeaders";
import { guardedAxios } from "./ssrf";
import { upstreamFailure } from "./upstream";

/**
 * Pipe a Deezer preview to the client as same-origin media, honoring the
 * client's Range header by forwarding it upstream and mirroring the
 * upstream's 206/416 so seeks land on the right bytes. A host that has no
 * such preview, or an address the guard refuses, answers 404 with
 * `notFoundMessage`; a host that is down or throttling answers 502. Anything
 * else is thrown to the caller.
 */
export async function proxyPreviewStream(
    res: Response,
    previewUrl: string,
    {
        notFoundMessage,
        logLabel,
        rangeHeader,
    }: { notFoundMessage: string; logLabel: string; rangeHeader?: string }
): Promise<void> {
    let upstream;
    try {
        upstream = await axios.get(previewUrl, {
            ...guardedAxios,
            responseType: "stream",
            timeout: 10000,
            headers: rangeHeader ? { Range: rangeHeader } : undefined,
            // 206 and 416 are the range protocol working, not failures.
            validateStatus: (status) =>
                (status >= 200 && status < 300) || status === 416,
        });
    } catch (error) {
        const failure = upstreamFailure(error);
        if (failure === "missing") {
            res.status(404).json({ error: notFoundMessage });
            return;
        }
        if (failure === "down") {
            logger.warn(`${logLabel} preview host did not answer: ${(error as Error).message}`);
            res.status(502).json({ error: "The preview's host did not answer; try again shortly" });
            return;
        }
        throw error;
    }

    const upstreamContentLength = upstreamHeader(upstream.headers["content-length"]);
    const upstreamAcceptRanges = upstreamHeader(upstream.headers["accept-ranges"]);
    const upstreamContentRange = upstreamHeader(upstream.headers["content-range"]);

    res.setHeader(
        "Content-Type",
        upstreamHeader(upstream.headers["content-type"]) || "audio/mpeg"
    );
    if (upstream.status === 206 || upstream.status === 416) {
        res.status(upstream.status);
        if (upstreamContentRange) {
            res.setHeader("Content-Range", upstreamContentRange);
        }
    }
    if (upstreamContentLength) {
        res.setHeader("Content-Length", upstreamContentLength);
    }
    if (upstreamAcceptRanges) {
        res.setHeader("Accept-Ranges", upstreamAcceptRanges);
    }
    res.setHeader("Cache-Control", "no-store");

    upstream.data.on("error", (streamErr: unknown) => {
        logger.error(`${logLabel} pipe error:`, streamErr);
        if (!res.headersSent) {
            res.status(502).end();
        } else {
            res.end();
        }
    });

    // Clean up upstream stream when client disconnects (preview cancelled, tab closed, etc)
    res.on("close", () => {
        if (!upstream.data.destroyed) {
            upstream.data.destroy();
        }
    });

    upstream.data.pipe(res);
}
