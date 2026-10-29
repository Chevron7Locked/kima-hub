/**
 * The public vibe routes at /api/public/vibe. Mounted only when
 * KIMA_PUBLIC_VIBE=true (config.publicVibe); every request carries
 * `Authorization: Bearer <KIMA_PUBLIC_VIBE_TOKEN>`. All routes are read-only.
 */
import { fetchChecked } from "../utils/ssrf";
import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import fs from "fs";
import zlib from "zlib";
import { promisify } from "util";
import { asyncHandler } from "../middleware/asyncHandler";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { USER_AGENT, config } from "../config";
import { latestLibraryExport } from "../services/publicLibraryExport";
import { getLiveState, liveListenerCount, publicUserId, subscribeLive, LiveEvent } from "../services/liveListening";
import { searchTracksByText, TextSearchRow } from "../services/textEmbeddingBridge";
import { findAlbumArtwork } from "../services/artwork";
import { getLocalImagePath } from "../services/imageStorage";
import { parseLimit } from "./library/paging";

const TRACK_ID_RE = /^c[a-z0-9]{16,30}$/;
const LIVE_STREAM_CAP = 4;
const HEARTBEAT_MS = 25_000;
const COVER_FETCH_TIMEOUT_MS = 15_000;

function digest(value: string): Buffer {
    return crypto.createHash("sha256").update(value).digest();
}

function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = config.publicVibe?.token;
    if (!expected || !presented || !crypto.timingSafeEqual(digest(presented), digest(expected))) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    next();
}

function etagFor(buffer: Buffer): string {
    return '"' + crypto.createHash("md5").update(buffer).digest("hex") + '"';
}

interface CoverBytes {
    buffer: Buffer;
    etag: string;
    contentType: string | null;
}

async function readLocalCover(ref: string): Promise<CoverBytes | null> {
    const file = getLocalImagePath(ref);
    if (!file) return null;
    const buffer = await fs.promises.readFile(file);
    return { buffer, etag: etagFor(buffer), contentType: null };
}

// Only covers Kima stores itself are served. A stored cover whose file has gone
// missing is looked up again through the artwork service.
async function resolveCoverBytes(trackId: string): Promise<CoverBytes | null> {
    const row = await prisma.track.findFirst({
        where: { id: trackId },
        select: {
            album: {
                select: {
                    coverUrl: true,
                    rgMbid: true,
                    title: true,
                    artist: { select: { name: true } },
                },
            },
        },
    });
    const album = row?.album;
    if (!album?.coverUrl?.startsWith("native:")) return null;
    const local = await readLocalCover(album.coverUrl);
    if (local || !album.rgMbid || !album.artist?.name) return local;

    const found = await findAlbumArtwork({
        rgMbid: album.rgMbid,
        artistName: album.artist.name,
        albumTitle: album.title,
    }).catch(() => null);
    if (!found?.url) return null;
    if (found.url.startsWith("native:")) return readLocalCover(found.url);
    const response = await fetchChecked(found.url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(COVER_FETCH_TIMEOUT_MS),
    }).catch(() => null);
    if (response?.status !== 200) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
        buffer,
        etag: etagFor(buffer),
        contentType: response.headers.get("content-type"),
    };
}

const gunzipAsync = promisify(zlib.gunzip);

const router = Router();
router.use(requireServiceToken);

/** GET /library: the whole mapped library, gzipped, with an ETag for cheap polling. */
router.get(
    "/library",
    asyncHandler(async (req: Request, res: Response) => {
        const library = latestLibraryExport();
        if (!library) {
            res.header("Retry-After", "30");
            res.status(503).json({ error: "The library export is being built" });
            return;
        }
        res.header("ETag", library.etag);
        res.header("Cache-Control", "no-cache");
        res.header("Vary", "Accept-Encoding");
        if (req.headers["if-none-match"] === library.etag) {
            res.status(304).end();
            return;
        }
        res.type("application/json");
        if (req.acceptsEncodings("gzip")) {
            res.header("Content-Encoding", "gzip");
            res.send(library.gzipped);
        } else {
            // Rare (most clients take gzip); decompress off the event loop.
            res.send(await gunzipAsync(library.gzipped));
        }
    }),
);

/** GET /live: what is playing now, for a client that has just connected. */
router.get(
    "/live",
    asyncHandler(async (_req: Request, res: Response) => {
        await publicUserId();
        res.header("Cache-Control", "no-store");
        res.json(getLiveState());
    }),
);

/** GET /live/events: the live trip as server-sent events, opening with the current state. */
router.get(
    "/live/events",
    asyncHandler(async (req: Request, res: Response) => {
        await publicUserId();
        if (liveListenerCount() >= LIVE_STREAM_CAP) {
            res.status(429).json({ error: "Live stream at capacity" });
            return;
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const send = (name: string, data: unknown) => {
            res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send("state", getLiveState());
        const unsubscribe = subscribeLive((event: LiveEvent) => send(event.type, event));
        const heartbeat = setInterval(() => res.write(": keepalive\n\n"), HEARTBEAT_MS);
        req.on("close", () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    }),
);

/** POST /search: tracks ranked against a text description, as the authed vibe search ranks them. */
router.post(
    "/search",
    asyncHandler(async (req: Request, res: Response) => {
        const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
        if (query.length < 2 || query.length > 500) {
            res.status(400).json({ error: "query must be 2-500 characters" });
            return;
        }
        try {
            const ranked = await searchTracksByText(query, parseLimit(req.query.limit, 20, 100));
            res.header("Cache-Control", "no-store");
            res.json({
                query,
                tracks: ranked.map((r: TextSearchRow) => ({
                    trackId: r.id,
                    title: r.title,
                    similarity: 1 - r.distance,
                    album: { id: r.albumId, title: r.albumTitle },
                    artist: { id: r.artistId, name: r.artistName },
                })),
            });
        } catch (e) {
            logger.error("[PUBLIC-VIBE] search error:", (e as Error).message);
            res.status(503).json({ error: "Search unavailable" });
        }
    }),
);

/** GET /cover/:trackId: the album cover for one track, as bytes. */
router.get(
    "/cover/:trackId",
    asyncHandler(async (req: Request, res: Response) => {
        const { trackId } = req.params;
        if (!TRACK_ID_RE.test(trackId)) {
            res.status(400).json({ error: "Invalid trackId format" });
            return;
        }
        const resolved = await resolveCoverBytes(trackId);
        if (!resolved) {
            res.status(404).end();
            return;
        }
        res.header("ETag", resolved.etag);
        if (req.headers["if-none-match"] === resolved.etag) {
            res.status(304).end();
            return;
        }
        res.header("Content-Type", resolved.contentType || "image/jpeg");
        // A track's cover can change (a better one found, a user edit): a day, revalidated by ETag.
        res.header("Cache-Control", "public, max-age=86400");
        res.send(resolved.buffer);
    }),
);

export default router;
