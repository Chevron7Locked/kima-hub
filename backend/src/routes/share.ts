import { Router, Request, Response } from "express";
import { createShareLink, ShareError } from "../services/shareService";
import { isTransactionConflict } from "../utils/dbConflict";
import { loadPublicAlbum, loadPublicPlaylist, loadPublicTrack, shareHoldsCover } from "../services/publicShare";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { PLAYABLE_SONG } from "../utils/playableSong";
import { createCoverLimiter, createRateLimiter } from "../middleware/rateLimiter";
import path from "path";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import { coverCacheControl, coverFileForSize, getLocalImagePath, parseStoredCover } from "../services/imageStorage";
import { sendStoredFile } from "../utils/sendStoredFile";
import { getAudioStreamingService } from "../services/audioStreaming";
import { config } from "../config";
import { redisClient } from "../utils/redis";
import { pexpireIfToken } from "../utils/tokenGuardedKey";

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

/**
 * Who is listening: the signed-in person when there is one, else the address and browser of the request. It is hashed, so
 * the window key in Redis holds neither. Two people playing one song are two listeners and each count a play; one
 * listener's seeks, wherever they come from in the same browser, are one.
 */
function listenerOf(req: Request): string {
    const userId = req.session?.userId;
    const who = userId ? `user:${userId}` : `anon:${req.ip ?? ""}|${req.get("user-agent") ?? ""}`;
    return createHash("sha256").update(who).digest("hex").slice(0, 24);
}

const playKeyFor = (shareId: string, trackId: string, listener: string) => `share:play:${shareId}:${trackId}:${listener}`;

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
 * Work a request leaves running after its response (renewing a play's window as the response closes, giving back a play
 * whose stream never started). It is tracked so it can be awaited: a test's teardown waits on `settleShareBackgroundWork`
 * so none of it reaches Redis or the database after they are closed. Nothing in the server calls it.
 */
const backgroundWork = new Set<Promise<unknown>>();

function track<T>(work: Promise<T>): Promise<T> {
    const entry = work.then(
        () => undefined,
        () => undefined,
    );
    backgroundWork.add(entry);
    void entry.then(() => backgroundWork.delete(entry));
    return work;
}

/** Resolves once no background work of a share request is left, including any that began while it waited. */
export async function settleShareBackgroundWork(): Promise<void> {
    while (backgroundWork.size > 0) await Promise.all([...backgroundWork]);
}

/**
 * A response of a play counts itself open while it streams, in a count kept under its window's token: it is added to as the
 * response begins, only while the window is still that token's, and every response renews it along with the window.
 */
const OPEN_RESPONSE = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("incr", KEYS[2])
redis.call("pexpire", KEYS[2], ARGV[2])
redis.call("pexpire", KEYS[1], ARGV[2])
return 1`;
/** A response is over: answers the responses of its play still open after it, 0 once the count is spent. */
const LEAVE_RESPONSE = `
local open = redis.call("decr", KEYS[1])
if open <= 0 then redis.call("del", KEYS[1]) return 0 end
return open`;
/** Frees the window only while it holds this token, a window that ended and was taken again being another play's, and no response of it is open. */
const RELEASE_WHEN_IDLE = `
if redis.call("get", KEYS[1]) ~= ARGV[1] then return 0 end
if tonumber(redis.call("get", KEYS[2]) or "0") > 0 then return 0 end
return redis.call("del", KEYS[1])`;

const PLAY_WINDOW_MS = PLAY_WINDOW_SECONDS * 1000;
const openCountKey = (token: string) => `share:open:${token}`;

/**
 * The window this listener's play of the song holds, as a claim, or null when there is none: a listener's requests keep one
 * play going however long the song is, and it ends 30 s after the last of them. The window is the listener's own, so it
 * is the token it holds that is renewed, and only while it is still that token. With Redis down no play is known: each
 * request counts.
 */
async function joinCountedPlay(key: string): Promise<PlayClaim | null> {
    try {
        const token = await redisClient.get(key);
        if (token === null) return null;
        // Renewed in one step with its token: a window that ended since it was read is not this request's to follow.
        return (await renewWindow(key, token)) ? newClaim(key, token) : null;
    } catch (error) {
        logger.warn(`[Share] Redis unavailable, counting every request: ${(error as Error).message}`);
        return null;
    }
}

/**
 * The window a request took for its play, or found its listener's. `token` is what the window holds, so the claim renews or
 * gives back only its own window; null when Redis was down and there is no window to hold. `open` is whether this response
 * is counted among those open on the window, and `left` is its one leaving.
 */
interface PlayClaim {
    key: string;
    token: string | null;
    open: boolean;
    left: Promise<number> | null;
}

const newClaim = (key: string, token: string | null): PlayClaim => ({ key, token, open: false, left: null });

/** Renews the window while it holds this token. Answers whether it was renewed: false when the window ended, was taken by another claim, or Redis failed. */
async function renewWindow(key: string, token: string): Promise<boolean> {
    try {
        return await pexpireIfToken(redisClient, key, token, PLAY_WINDOW_MS);
    } catch (error) {
        logger.warn(`[Share] Could not renew a play window: ${(error as Error).message}`);
        return false;
    }
}

/** Renews the claim's window, and its count of open responses along with it. */
async function renewClaim(claim: PlayClaim): Promise<void> {
    if (claim.token === null || !(await renewWindow(claim.key, claim.token)) || !claim.open) return;
    try {
        await redisClient.pexpire(openCountKey(claim.token), PLAY_WINDOW_MS);
    } catch (error) {
        logger.warn(`[Share] Could not renew a play window's count: ${(error as Error).message}`);
    }
}

/** This response is now open on its window. It is not counted when the window ended since it was taken, or Redis failed. */
async function openResponse(claim: PlayClaim): Promise<void> {
    if (claim.token === null) return;
    try {
        claim.open = (await redisClient.eval(OPEN_RESPONSE, 2, claim.key, openCountKey(claim.token), claim.token, String(PLAY_WINDOW_MS))) === 1;
    } catch (error) {
        logger.warn(`[Share] Could not count a response of a play: ${(error as Error).message}`);
    }
}

/** This response is over, however often it is asked. Answers how many responses of its play are still open. */
function leaveResponse(claim: PlayClaim): Promise<number> {
    return (claim.left ??= track((async () => {
        if (claim.token === null || !claim.open) return 0;
        try {
            return Number(await redisClient.eval(LEAVE_RESPONSE, 1, openCountKey(claim.token)));
        } catch (error) {
            logger.warn(`[Share] Could not leave a play window's count: ${(error as Error).message}`);
            return 0;
        }
    })()));
}

/**
 * A listener who pauses holds one response open and may seek later, past the window. While a response of the play is
 * open, and once more as it closes, the window is renewed, so the seek is a follow-up and not a new play. A request renews
 * only the token it holds: the one it took the window with, or the one it found in the listener's window.
 */
function keepWindowWhileOpen(res: Response, claim: PlayClaim): void {
    const timer = setInterval(() => void track(renewClaim(claim)), PLAY_WINDOW_MS / 3);
    timer.unref();
    res.once("close", () => {
        clearInterval(timer);
        void track(renewClaim(claim).then(() => leaveResponse(claim)));
    });
}

/** Takes the window for this play. Null when a request of the same play took it first; a claim with no token when Redis is down. */
async function claimPlayWindow(key: string): Promise<PlayClaim | null> {
    const token = randomUUID();
    try {
        return (await redisClient.set(key, token, "EX", PLAY_WINDOW_SECONDS, "NX")) === "OK" ? newClaim(key, token) : null;
    } catch (error) {
        logger.warn(`[Share] Redis unavailable, counting every request: ${(error as Error).message}`);
        return newClaim(key, null);
    }
}

/** Frees the window if it is still this claim's and no response of the play is open. */
async function releasePlayWindow(claim: PlayClaim): Promise<void> {
    if (claim.token === null) return;
    try {
        await redisClient.eval(RELEASE_WHEN_IDLE, 2, claim.key, openCountKey(claim.token), claim.token);
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

/** The longest a response waits for its play to be given back before it ends: a stalled database must not hold a listener's connection open. */
const TAKE_BACK_WAIT_MS = 3000;

/** Waits for the take-back, but not past TAKE_BACK_WAIT_MS: it then finishes in the background (it is tracked) and a warning is logged. */
async function undoWithinReason(undo: () => Promise<void>, shareId: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), TAKE_BACK_WAIT_MS);
        timer.unref();
    });
    try {
        if ((await Promise.race([undo(), waited])) === "late") {
            logger.warn(`[Share] Giving back a play of share ${shareId} is taking over ${TAKE_BACK_WAIT_MS} ms; ending the response without waiting`);
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Keeps a counted play only if the stream starts. A play whose response ends without one (304, 404, 416, 500, or a listener
 * who left first) is taken back and its window freed, so the next request counts. The take-back runs before the response
 * ends: a client cannot follow up in between and slip into a window that is about to be freed. The response waits for it
 * only up to TAKE_BACK_WAIT_MS, so a stalled database cannot hold the connection open.
 */
function keepPlayOnlyIfStreamStarts(res: Response, shareId: string, claim: PlayClaim): void {
    let undone: Promise<void> | null = null;
    const undo = () =>
        (undone ??= track((async () => {
            // A seek of the same play that is open is playing it: the play stays counted, and the window is its to use.
            if ((await leaveResponse(claim)) > 0) return;
            try {
                await prisma.$executeRaw`
                    UPDATE "share_links" SET "playCount" = GREATEST("playCount" - 1, 0) WHERE "id" = ${shareId}
                `;
            } catch (error) {
                logger.error(`[Share] Could not give back a play: ${(error as Error).message}`);
            }
            await releasePlayWindow(claim);
        })()));

    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    res.end = ((...args: unknown[]) => {
        if (streamStarted(res)) return end(...args);
        // The response ends whatever the take-back does, so a rejection of it must not become an unhandled one.
        void undoWithinReason(undo, shareId).catch(() => undefined).finally(() => end(...args));
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
        const playKey = playKeyFor(shareLink.id, trackId, listenerOf(req));

        // A listener's follow-up requests (a seek, the next range) belong to a play already counted for that listener: they
        // are not a new play, and the limit, which that play may just have reached, does not apply to them. Expiry still
        // does. Another listener's play is not this one's: it has its own window.
        const joined = await joinCountedPlay(playKey);
        if (!joined && outOfPlays(shareLink)) {
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

        // The first request of a listener's play takes the window and counts it. A request that finds the window taken
        // belongs to that play: two requests of one listener arriving together are one play.
        let claim: PlayClaim | null = joined;
        if (!joined) {
            claim = await claimPlayWindow(playKey);
            if (claim) {
                await openResponse(claim);
                if (!(await countPlay(shareLink.id))) {
                    await leaveResponse(claim);
                    await releasePlayWindow(claim);
                    return sendEnded(res, "play-limit");
                }
                keepPlayOnlyIfStreamStarts(res, shareLink.id, claim);
            }
        } else {
            await openResponse(joined);
        }
        if (claim) {
            keepWindowWhileOpen(res, claim);
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
