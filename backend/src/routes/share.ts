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
import { refuseRequest } from "../utils/errors";

const router = Router();

// An answer that refuses (not found, ended, not in the share) is never cached, so a link that is dead stays dead for the
// browser and a proxy, and one that comes back is seen at once. Answers that serve keep the headers they set.
function refuse(res: Response, status: number, error: string): Response {
    if (!res.headersSent) res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ error });
}

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

/** The share link for `token`, or null once the response has gone out: 404 unknown, 410 expired. */
async function loadLiveShareLink(token: string, res: Response) {
    const shareLink = await prisma.shareLink.findUnique({ where: { token } });

    if (!shareLink) {
        refuse(res, 404, "Share link not found");
        return null;
    }

    if (shareLink.expiresAt && shareLink.expiresAt < new Date()) {
        refuse(res, 410, "Share link has expired");
        return null;
    }

    return shareLink;
}

/**
 * One more visit to the share: its `playCount`, which Subsonic apps show as the share's visitCount. Only opening the share
 * counts, as in Navidrome; streams and covers of an open page do not. A count that cannot be saved is logged and never
 * fails the request.
 */
async function countVisit(shareId: string): Promise<void> {
    try {
        await prisma.shareLink.updateMany({ where: { id: shareId }, data: { playCount: { increment: 1 } } });
    } catch (error) {
        logger.warn(`[Share] Could not count a visit to share ${shareId}: ${(error as Error).message}`);
    }
}

/**
 * What a song must satisfy to be covered by a link, as a `where` on Track: null when the link can never cover that song, `{}`
 * when the link is to the song itself, else the filter (the album, the playlist) the song has to match. The keys stay clear
 * of those of the playable rule it is merged with.
 */
function coverageOf(link: { entityType: string; entityId: string }, trackId: string) {
    if (link.entityType === "track") return link.entityId === trackId ? {} : null;
    if (link.entityType === "album") return { albumId: link.entityId };
    if (link.entityType === "playlist") return { playlistItems: { some: { playlistId: link.entityId } } };
    return null;
}

/**
 * The song a link plays for this id: its file path when the link covers it and it is a playable song, "not-covered" when
 * the link does not hold it (403) and "not-playable" when it holds it but it is missing, corrupt, Discover or has no file
 * path (404). One query answers a song that plays; the second only tells the two refusals apart.
 */
async function songOfShare(
    link: { entityType: string; entityId: string },
    trackId: string,
): Promise<{ filePath: string } | "not-covered" | "not-playable"> {
    const coverage = coverageOf(link, trackId);
    if (coverage === null) return "not-covered";
    const song = await prisma.track.findFirst({
        where: { id: trackId, ...coverage, ...PLAYABLE_SONG },
        select: { filePath: true },
    });
    if (song?.filePath) return { filePath: song.filePath };
    // A link to the song itself covers it by id alone; any other link must hold it for the refusal to be a 404.
    if (link.entityType === "track") return "not-playable";
    const held = await prisma.track.findFirst({ where: { id: trackId, ...coverage }, select: { id: true } });
    return held ? "not-playable" : "not-covered";
}

/**
 * POST /api/share - Create a share link (authenticated)
 */
router.post("/", async (req: Request, res: Response) => {
    try {
        const { entityType, entityId } = req.body;
        if (!entityType || !entityId) {
            return refuseRequest(req, res, "entityType and entityId required");
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
            return refuse(res, status, error.message);
        }
        // Both runs lost to another transaction: nothing was written, and asking again is safe.
        if (isTransactionConflict(error)) {
            return refuse(res, 409, "Concurrent share change, please retry");
        }
        logger.error(`[Share] Failed to create share link: ${error.message}`);
        refuse(res, 500, "Failed to create share link");
    }
});

/**
 * GET /api/share/:token - Resolve a share link (public, no auth)
 */
router.get("/:token", shareResolveLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await loadLiveShareLink(req.params.token, res);
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
            return refuse(res, 404, "Shared content no longer exists");
        }

        // Only a person opening the page is a visit. A HEAD (a probe, a link checker) opens nothing, and the web server's
        // reads for the page card (a chat app unfurling the link) and for a check after a playback error ask `?count=0`.
        // Anyone may send it: hiding a visit harms nobody.
        if (req.method !== "HEAD" && req.query.count !== "0") await countVisit(shareLink.id);

        res.json({
            entityType: shareLink.entityType,
            entity,
            createdAt: shareLink.createdAt,
        });
    } catch (error: any) {
        logger.error(`[Share] Failed to resolve share link: ${error.message}`);
        refuse(res, 500, "Failed to load shared content");
    }
});

/**
 * GET /api/share/:token/cover-art/:coverArtId - Serve cover art via share token (public)
 */
router.get("/:token/cover-art/:coverArtId", shareCoverLimiter, async (req: Request, res: Response) => {
    try {
        const shareLink = await loadLiveShareLink(req.params.token, res);
        if (!shareLink) return;

        const { coverArtId } = req.params;
        const size = req.query.size as string | undefined;

        // A share shows only its own content: any other cover, an artist picture or another album's, is not found.
        const stored = parseStoredCover(coverArtId);
        const localPath = stored && getLocalImagePath(coverArtId);
        if (!stored || !localPath || !(await shareHoldsCover(shareLink, stored.relativePath))) {
            return refuse(res, 404, "Cover art not found");
        }

        // The same width limits and stored-copy rules as the library cover route: a copy older than its cover is made again.
        const file = await coverFileForSize(localPath, stored.relativePath, size);

        return sendStoredFile(
            res,
            file,
            { headers: { "Content-Type": "image/jpeg", "Cache-Control": coverCacheControl(stored.version) } },
            () => void refuse(res, 404, "Cover art not found"),
        );
    } catch (error: any) {
        logger.error(`[Share] Cover art error: ${error.message}`);
        refuse(res, 500, "Failed to serve cover art");
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

        // Whatever the link covers, only a playable song streams: a missing, corrupt or Discover song is not found.
        const found = await songOfShare(shareLink, trackId);
        if (found === "not-covered") {
            return refuse(res, 403, "Track not in shared content");
        }
        if (found === "not-playable") {
            return refuse(res, 404, "Track file not found");
        }
        const track = found;

        const musicPath = config.music.musicPath;
        const resolvedMusicPath = path.resolve(musicPath);
        const fullPath = path.resolve(resolvedMusicPath, track.filePath);

        if (!fullPath.startsWith(resolvedMusicPath + path.sep)) {
            return refuse(res, 403, "Access denied");
        }

        try {
            await fs.promises.access(fullPath, fs.constants.R_OK);
        } catch {
            return refuse(res, 404, "Audio file not found");
        }

        const mimeType = getMimeType(track.filePath);
        const streamingService = getAudioStreamingService(
            config.music.transcodeCachePath,
            config.music.transcodeCacheMaxGb,
        );
        // The audio is not kept by the browser: a link that is revoked or expired must stop playing.
        await streamingService.streamFileWithRangeSupport(req, res, fullPath, mimeType, { cacheControl: "private, no-store" });
    } catch (error: any) {
        logger.error(`[Share] Stream error: ${error.message}`);
        if (!res.headersSent) {
            refuse(res, 500, "Failed to stream audio");
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
            return refuse(res, 404, "Share link not found");
        }

        if (shareLink.createdBy !== req.user!.id) {
            return refuse(res, 403, "Not the link owner");
        }

        await prisma.shareLink.delete({ where: { id: shareLink.id } });

        res.json({ message: "Share link revoked" });
    } catch (error: any) {
        logger.error(`[Share] Failed to revoke share link: ${error.message}`);
        refuse(res, 500, "Failed to revoke share link");
    }
});

export default router;
