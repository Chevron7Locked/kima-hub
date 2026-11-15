import { Router, Request, Response } from "express";
import { createShareLink, ShareError } from "../services/shareService";
import { isTransactionConflict } from "../utils/dbConflict";
import { loadPublicAlbum, loadPublicPlaylist, loadPublicTrack, shareHoldsCover } from "../services/publicShare";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { createCoverLimiter, createRateLimiter } from "../middleware/rateLimiter";
import path from "path";
import fs from "fs";
import { coverCacheControl, coverFileForSize, getLocalImagePath, parseStoredCover } from "../services/imageStorage";
import { sendStoredFile } from "../utils/sendStoredFile";
import { getAudioStreamingService } from "../services/audioStreaming";
import { config } from "../config";
import { redisClient } from "../utils/redis";

const router = Router();

// An answer that refuses (not found, ended, not in the share) is never cached, so a link that is dead stays dead for the
// browser and a proxy, and one that comes back is seen at once. Answers that serve keep the headers they set.
router.use((_req: Request, res: Response, next) => {
    const json = res.json.bind(res);
    res.json = (body?: unknown) => {
        if (res.statusCode >= 400 && !res.headersSent) res.setHeader("Cache-Control", "no-store");
        return json(body);
    };
    next();
});

// One play is every request a listener makes for a song while it goes on: the browser asks again for each seek. The play
// ends this long after the last of them.
const PLAY_WINDOW_SECONDS = 30;
const playKeyFor = (shareId: string, trackId: string) => `share:play:${shareId}:${trackId}`;

const shareResolveLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

// A playlist page asks for one cover per song, so covers count apart from opening the share.
const shareCoverLimiter = createCoverLimiter();

const shareStreamLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 300 });

function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
        ".mp3": "audio/mpeg",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".opus": "audio/opus",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".wma": "audio/x-ms-wma",
    };
    return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Why a link has ended, in the 410 body next to the message: the page tells "expired" from "play limit" by `reason`, not by
 * the words in `error`. The status stays 410 for both; the iOS app reads only the status.
 */
type EndedReason = "expired" | "play-limit";

function sendEnded(res: Response, reason: EndedReason): void {
    res.status(410).json({
        error: reason === "expired" ? "Share link has expired" : "Share link play limit reached",
        reason,
    });
}

/** The share link for `token`, or null once the response has gone out: 404 unknown, 410 expired. */
async function loadLiveShareLink(token: string, res: Response) {
    const shareLink = await prisma.shareLink.findUnique({ where: { token } });

    if (!shareLink) {
        res.status(404).json({ error: "Share link not found" });
        return null;
    }

    if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
        sendEnded(res, "expired");
        return null;
    }

    return shareLink;
}

/** A limit of 0 plays is a limit: only no limit at all (null) is unlimited. */
const outOfPlays = (link: { maxPlays: number | null; playCount: number }) =>
    link.maxPlays != null && link.playCount >= link.maxPlays;

/** The share link for `token`, or null once the response has gone out: 404 unknown, 410 expired or out of plays. */
async function loadUsableShareLink(token: string, res: Response) {
    const shareLink = await loadLiveShareLink(token, res);
    if (!shareLink) return null;

    if (outOfPlays(shareLink)) {
        sendEnded(res, "play-limit");
        return null;
    }

    return shareLink;
}

/**
 * Whether a play of this song is already counted for the share, and if so renews its window: a listener's requests keep one
 * play going however long the song is, and it ends 30 s after the last of them. With Redis down no play is known: each
 * request counts.
 */
async function continuePlay(key: string): Promise<boolean> {
    try {
        return (await redisClient.expire(key, PLAY_WINDOW_SECONDS)) === 1;
    } catch (error) {
        logger.warn(`[Share] Redis unavailable, counting every request: ${(error as Error).message}`);
        return false;
    }
}

/** Takes the window for this play. False when a request of the same play took it first; true too when Redis is down. */
async function claimPlayWindow(key: string): Promise<boolean> {
    try {
        return (await redisClient.set(key, "1", "EX", PLAY_WINDOW_SECONDS, "NX")) === "OK";
    } catch (error) {
        logger.warn(`[Share] Redis unavailable, counting every request: ${(error as Error).message}`);
        return true;
    }
}

async function releasePlayWindow(key: string): Promise<void> {
    try {
        await redisClient.del(key);
    } catch (error) {
        logger.warn(`[Share] Could not release a play window: ${(error as Error).message}`);
    }
}

/** Counts one play if the share has one left, as one statement so two listeners cannot both take the last. */
async function countPlay(shareId: string): Promise<boolean> {
    const updated = await prisma.$executeRaw`
        UPDATE "share_links"
        SET "playCount" = "playCount" + 1
        WHERE "id" = ${shareId}
          AND ("maxPlays" IS NULL OR "playCount" < "maxPlays")
    `;
    return updated > 0;
}

/**
 * Whether the audio stream began: bytes went out. The streaming module sets 200 or 206 with the file's headers
 * (`Accept-Ranges`) just before it pipes, and the headers leave with the first chunk; every other end (304, 404, 416, 500,
 * a listener who left first) has another status, no such header, or nothing sent.
 */
const streamStarted = (res: Response) =>
    (res.statusCode === 200 || res.statusCode === 206) && res.getHeader("Accept-Ranges") !== undefined && res.headersSent;

/**
 * Keeps a counted play only if the stream starts. A play whose response ends without one (304, 404, 416, 500, or a listener
 * who left first) is taken back and its window freed, so the next request counts. The take-back runs before the response
 * ends: a client cannot follow up in between and slip into a window that is about to be freed.
 */
function keepPlayOnlyIfStreamStarts(res: Response, shareId: string, key: string): void {
    let undone: Promise<void> | null = null;
    const undo = () =>
        (undone ??= (async () => {
            try {
                await prisma.$executeRaw`
                    UPDATE "share_links" SET "playCount" = GREATEST("playCount" - 1, 0) WHERE "id" = ${shareId}
                `;
            } catch (error) {
                logger.error(`[Share] Could not give back a play: ${(error as Error).message}`);
            }
            await releasePlayWindow(key);
        })());

    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    res.end = ((...args: unknown[]) => {
        if (streamStarted(res)) return end(...args);
        void undo().finally(() => end(...args));
        return res;
    }) as Response["end"];
    res.once("close", () => {
        if (!streamStarted(res)) void undo();
    });
    // A listener who left while the play was being counted has already closed: the listener above would never run.
    if (res.destroyed && !streamStarted(res)) void undo();
}

/**
 * POST /api/share - Create a share link (authenticated)
 */
router.post("/", async (req: Request, res: Response) => {
    try {
        const { entityType, entityId } = req.body;
        if (!entityType || !entityId) {
            return res
                .status(400)
                .json({ error: "entityType and entityId are required" });
        }

        // Creation lives in shareService so the Subsonic surface can create a
        // REAL share rather than fabricating one.
        // Named fields only: the stored dates and play count in the result are for the Subsonic reply, not the web's.
        const { token, url, existing } = await createShareLink(req.user!.id, entityType, entityId);
        res.json({ token, url, existing });
    } catch (error: any) {
        if (error instanceof ShareError) {
            const status =
                error.code === "INVALID_ENTITY_TYPE" ? 400
                : error.code === "NOT_FOUND" ? 404
                : error.code === "FORBIDDEN" ? 403
                : 429;
            return res.status(status).json({ error: error.message });
        }
        // Both runs lost to another transaction: nothing was written, and asking again is safe.
        if (isTransactionConflict(error)) {
            return res.status(409).json({ error: "Concurrent share change, please retry" });
        }
        logger.error(`[Share] Failed to create share link: ${error.message}`);
        res.status(500).json({ error: "Failed to create share link" });
    }
});

/**
 * GET /api/share/:token - Resolve a share link (public, no auth)
 */
router.get("/:token", shareResolveLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await loadUsableShareLink(req.params.token, res);
        if (!shareLink) return;

        let entity: object | null = null;

        if (shareLink.entityType === "playlist") {
            entity = await loadPublicPlaylist(shareLink.entityId);
        } else if (shareLink.entityType === "track") {
            entity = await loadPublicTrack(shareLink.entityId);
        } else if (shareLink.entityType === "album") {
            entity = await loadPublicAlbum(shareLink.entityId);
        }

        if (!entity) {
            return res.status(404).json({ error: "Shared content no longer exists" });
        }

        res.json({
            entityType: shareLink.entityType,
            entity,
            createdAt: shareLink.createdAt,
        });
    } catch (error: any) {
        logger.error(`[Share] Failed to resolve share link: ${error.message}`);
        res.status(500).json({ error: "Failed to load shared content" });
    }
});

/**
 * GET /api/share/:token/cover-art/:coverArtId - Serve cover art via share token (public)
 */
router.get("/:token/cover-art/:coverArtId", shareCoverLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await loadUsableShareLink(req.params.token, res);
        if (!shareLink) return;

        const { coverArtId } = req.params;
        const size = req.query.size as string | undefined;

        if (!coverArtId.startsWith("native:")) {
            return res.status(404).json({ error: "Cover art not found" });
        }

        // A share shows only its own content: any other cover, an artist picture or another album's, is not found.
        if (!(await shareHoldsCover(shareLink, coverArtId))) {
            return res.status(404).json({ error: "Cover art not found" });
        }

        const localPath = getLocalImagePath(coverArtId);
        const stored = parseStoredCover(coverArtId);
        if (!localPath || !stored) {
            return res.status(404).json({ error: "Cover art not found" });
        }

        // The same width limits and stored-copy rules as the library cover route: a copy older than its cover is made again.
        const file = await coverFileForSize(localPath, stored.relativePath, size);

        return sendStoredFile(
            res,
            file,
            { headers: { "Content-Type": "image/jpeg", "Cache-Control": coverCacheControl(stored.version) } },
            () => void res.status(404).json({ error: "Cover art not found" }),
        );
    } catch (error: any) {
        logger.error(`[Share] Cover art error: ${error.message}`);
        res.status(500).json({ error: "Failed to serve cover art" });
    }
});

/**
 * GET /api/share/:token/stream/:trackId - Stream audio via share token (public, no auth)
 */
router.get("/:token/stream/:trackId", shareStreamLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await loadLiveShareLink(req.params.token, res);
        if (!shareLink) return;

        const trackId = req.params.trackId;
        const playKey = playKeyFor(shareLink.id, trackId);

        // A listener's follow-up requests (a seek, the next range) belong to a play already counted: they are not a new
        // play, and the limit, which that play may just have reached, does not apply to them. Expiry still does.
        const followUp = await continuePlay(playKey);
        if (!followUp && outOfPlays(shareLink)) {
            return sendEnded(res, "play-limit");
        }

        let authorized = false;

        if (shareLink.entityType === "track" && shareLink.entityId === trackId) {
            authorized = true;
        } else if (shareLink.entityType === "playlist") {
            const item = await prisma.playlistItem.findFirst({
                where: { playlistId: shareLink.entityId, trackId },
            });
            authorized = !!item;
        } else if (shareLink.entityType === "album") {
            const track = await prisma.track.findFirst({
                where: { id: trackId, albumId: shareLink.entityId },
            });
            authorized = !!track;
        }

        if (!authorized) {
            return res.status(403).json({ error: "Track not in shared content" });
        }

        // Whatever the link covers, only a playable song streams: a missing, corrupt or Discover song is not found.
        const track = await prisma.track.findFirst({
            where: { id: trackId, ...PLAYABLE_SONG },
            select: { filePath: true },
        });

        if (!track?.filePath) {
            return res.status(404).json({ error: "Track file not found" });
        }

        const musicPath = config.music.musicPath;
        const resolvedMusicPath = path.resolve(musicPath);
        const fullPath = path.resolve(resolvedMusicPath, track.filePath);

        if (!fullPath.startsWith(resolvedMusicPath + path.sep)) {
            return res.status(403).json({ error: "Access denied" });
        }

        try {
            await fs.promises.access(fullPath, fs.constants.R_OK);
        } catch {
            return res.status(404).json({ error: "Audio file not found" });
        }

        // The first request of a play takes the window and counts it. A request that finds the window taken belongs to
        // that play: two requests arriving together are one play.
        if (!followUp && (await claimPlayWindow(playKey))) {
            if (!(await countPlay(shareLink.id))) {
                await releasePlayWindow(playKey);
                return sendEnded(res, "play-limit");
            }
            keepPlayOnlyIfStreamStarts(res, shareLink.id, playKey);
        }

        const mimeType = getMimeType(track.filePath);
        const streamingService = getAudioStreamingService(
            config.music.transcodeCachePath,
            config.music.transcodeCacheMaxGb,
        );
        // The audio is not kept by the browser: a link that is revoked, expired or out of plays must stop playing, and every
        // play must reach this route to be counted.
        await streamingService.streamFileWithRangeSupport(req, res, fullPath, mimeType, { cacheControl: "private, no-store" });
    } catch (error: any) {
        logger.error(`[Share] Stream error: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: "Failed to stream audio" });
        }
    }
});

/**
 * DELETE /api/share/:token - Revoke a share link (authenticated, owner only)
 */
router.delete("/:token", async (req: Request, res: Response) => {
    try {
        const shareLink = await prisma.shareLink.findUnique({
            where: { token: req.params.token },
        });

        if (!shareLink) {
            return res.status(404).json({ error: "Share link not found" });
        }

        if (shareLink.createdBy !== req.user!.id) {
            return res.status(403).json({ error: "Not the link owner" });
        }

        await prisma.shareLink.delete({ where: { id: shareLink.id } });

        res.json({ message: "Share link revoked" });
    } catch (error: any) {
        logger.error(`[Share] Failed to revoke share link: ${error.message}`);
        res.status(500).json({ error: "Failed to revoke share link" });
    }
});

export default router;
