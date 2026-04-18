import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID } from "crypto";
import { subsonicAuth } from "../../middleware/subsonicAuth";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { prisma } from "../../utils/db";
import { scanQueue } from "../../workers/queues";
import { config } from "../../config";
import { logger } from "../../utils/logger";

import { compatRouter } from "./compat";
import { libraryRouter } from "./library";
import { playbackRouter } from "./playback";
import { searchRouter } from "./search";
import { playlistRouter } from "./playlists";
import { queueRouter } from "./queue";
import { starredRouter } from "./starred";
import { artistInfoRouter } from "./artistInfo";
import { lyricsRouter } from "./lyrics";
import { userManagementRouter } from "./userManagement";
import { profileRouter } from "./profile";
import { podcastRouter } from "./podcasts";

export const subsonicRouter = Router();

const SENSITIVE_SUBSONIC_QUERY_KEYS = new Set(["p", "t", "s", "apiKey"]);

function redactSubsonicQuery(query: Request["query"]) {
    return Object.fromEntries(
        Object.entries(query).map(([key, value]) => {
            if (SENSITIVE_SUBSONIC_QUERY_KEYS.has(key)) {
                return [key, "[REDACTED]"];
            }
            return [key, value];
        })
    );
}

// Debug trace for Subsonic API requests and responses.
subsonicRouter.use((req: Request, res: Response, next) => {
    const startedAt = Date.now();
    const query = redactSubsonicQuery(req.query);
    const requestId = req.get("x-request-id") || randomUUID();

    res.locals.subsonicRequestId = requestId;
    res.setHeader("x-request-id", requestId);

    logger.debug(`[Subsonic] --> ${req.method} ${req.originalUrl}`, {
        requestId,
        path: req.path,
        query,
        userAgent: req.get("user-agent") || "unknown",
        clientIp: req.ip,
    });

    res.on("finish", () => {
        logger.debug(`[Subsonic] <-- ${req.method} ${req.path}`, {
            requestId,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            contentType: res.getHeader("content-type"),
            userId: req.user?.id,
            username: req.user?.username,
        });
    });

    next();
});

// Rate limit the Subsonic API separately: auth does a DB query on every request
const subsonicLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1500, // 1500 req/min per IP — Symfonium fires per-album requests during sync
    standardHeaders: true,
    legacyHeaders: false,
});
subsonicRouter.use(subsonicLimiter);

// Normalize paths: append .view suffix if missing for client compatibility.
// Some clients (e.g. Musa) send /rest/ping instead of /rest/ping.view.
subsonicRouter.use((req: Request, res: Response, next) => {
    if (!req.path.endsWith(".view")) {
        req.url = req.path + ".view" + (req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "");
    }
    next();
});

// OpenSubsonic tokenInfo is API key based and does not require Subsonic user auth.
subsonicRouter.all("/tokenInfo.view", async (req: Request, res: Response) => {
    const apiKey = req.query.apiKey as string | undefined;
    if (!apiKey) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: apiKey");
    }

    const keyRecord = await prisma.apiKey.findUnique({
        where: { key: apiKey },
        select: {
            id: true,
            user: { select: { username: true } },
        },
    });

    if (!keyRecord) {
        return subsonicError(req, res, SubsonicError.INVALID_API_KEY, "Invalid API key");
    }

    prisma.apiKey
        .update({ where: { id: keyRecord.id }, data: { lastUsed: new Date() } })
        .catch(() => {});

    return subsonicOk(req, res, {
        tokenInfo: {
            username: keyRecord.user.username,
        },
    });
});

// All routes require Subsonic auth (applied after rate limit)
subsonicRouter.use(subsonicAuth);

// ===================== SYSTEM =====================

subsonicRouter.all("/ping.view", (req: Request, res: Response) => {
    subsonicOk(req, res);
});

subsonicRouter.all("/getLicense.view", (req: Request, res: Response) => {
    subsonicOk(req, res, {
        license: {
            "@_valid": true,
            "@_email": "kima@kima",
            "@_licenseExpires": "2099-12-31T23:59:59",
        },
    });
});

subsonicRouter.all("/getMusicFolders.view", (req: Request, res: Response) => {
    subsonicOk(req, res, {
        musicFolders: {
            musicFolder: [{ "@_id": 1, "@_name": "Music" }],
        },
    });
});

// OpenSubsonic extensions advertised by this server.
// Extension items use plain keys (not @_ prefix) since they are JSON object
// properties, not XML attributes. XMLBuilder emits them as child elements.
subsonicRouter.all("/getOpenSubsonicExtensions.view", (req: Request, res: Response) => {
    subsonicOk(req, res, {
        openSubsonicExtensions: [
            { "@_name": "apiKeyAuthentication", versions: [1] },
            { "@_name": "songLyrics", versions: [1, 2] },
            { "@_name": "indexBasedQueue", versions: [1] },
            { "@_name": "getPodcastEpisode", versions: [1] },
        ],
    });
});

subsonicRouter.all("/getScanStatus.view", async (req: Request, res: Response) => {
    const counts = await scanQueue.getJobCounts("active", "waiting", "delayed");
    const queued = (counts.active || 0) + (counts.waiting || 0) + (counts.delayed || 0);
    subsonicOk(req, res, {
        scanStatus: {
            scanning: queued > 0,
            count: queued,
        },
    });
});

subsonicRouter.all("/startScan.view", async (req: Request, res: Response) => {
    if (!config.music.musicPath) {
        return subsonicError(req, res, SubsonicError.GENERIC, "Music path not configured");
    }

    await scanQueue.add("scan", {
        userId: req.user!.id,
        musicPath: config.music.musicPath,
    });

    const counts = await scanQueue.getJobCounts("active", "waiting", "delayed");
    const queued = (counts.active || 0) + (counts.waiting || 0) + (counts.delayed || 0);

    subsonicOk(req, res, {
        scanStatus: {
            scanning: true,
            count: queued,
        },
    });
});

subsonicRouter.all(["/getAlbumInfo.view", "/getAlbumInfo2.view"], (req: Request, res: Response) => {
    subsonicOk(req, res, { albumInfo: {} });
});

subsonicRouter.use(compatRouter);

subsonicRouter.use(libraryRouter);
subsonicRouter.use(playbackRouter);
subsonicRouter.use(searchRouter);
subsonicRouter.use(playlistRouter);
subsonicRouter.use(queueRouter);
subsonicRouter.use(starredRouter);
subsonicRouter.use(artistInfoRouter);
subsonicRouter.use(lyricsRouter);
subsonicRouter.use(userManagementRouter);
subsonicRouter.use(profileRouter);
subsonicRouter.use(podcastRouter);

// Catch-all: inform clients that an endpoint isn't implemented yet
subsonicRouter.all("*", (req: Request, res: Response) => {
    subsonicError(req, res, SubsonicError.GENERIC, `Not implemented: ${req.path}`);
});
