import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { subsonicAuth } from "../../middleware/subsonicAuth";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { prisma } from "../../utils/db";
import { scanQueue } from "../../workers/queues";
import { config } from "../../config";
import { requireSubsonicAdmin } from "./userHelpers";
import { hashApiKey } from "../../services/users/apiKeyStore";
// Every async handler here goes through wrap(): in Express 4 a rejected handler
// promise produces NO response, so an unwrapped await that throws leaves the
// client waiting until it times out. getScanStatus and startScan both talk to
// Redis, which being unreachable is ordinary traffic rather than an edge case.
import { wrap } from "./mappers";

/**
 * Bound a queue call so an unreachable Redis answers instead of hanging.
 *
 * wrap() above is not enough on its own, and that distinction cost a real
 * measurement: when Redis is down, ioredis does NOT reject: it queues the
 * command and retries the connection, so `getJobCounts` stays PENDING forever.
 * wrap() can only answer for a promise that settles. Measured against this
 * server with Redis stopped, the request produced no response at all and the
 * client gave up after 25 seconds.
 *
 * A deadline turns "never settles" into a rejection, which wrap() then turns
 * into a Subsonic error. Five seconds is far longer than a healthy local queue
 * read (measured at ~6ms) and far shorter than any client's patience.
 */
const QUEUE_DEADLINE_MS = 5_000;

function withQueueDeadline<T>(work: Promise<T>, label: string): Promise<T> {
    return Promise.race([
        work,
        new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`${label} timed out after ${QUEUE_DEADLINE_MS}ms`)),
                QUEUE_DEADLINE_MS
            ).unref()
        ),
    ]);
}

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
subsonicRouter.all("/tokenInfo.view", wrap(async (req: Request, res: Response) => {
    const apiKey = req.query.apiKey as string | undefined;
    if (!apiKey) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: apiKey");
    }

    const keyRecord = await prisma.apiKey.findUnique({
        where: { keyHash: hashApiKey(apiKey) },
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
}));

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
            { name: "apiKeyAuthentication", versions: [1] },
            { name: "songLyrics", versions: [1] },
            { name: "indexBasedQueue", versions: [1] },
            { name: "getPodcastEpisode", versions: [1] },
        ],
    });
});

subsonicRouter.all("/getScanStatus.view", wrap(async (req: Request, res: Response) => {
    const counts = await withQueueDeadline(scanQueue.getJobCounts("active", "waiting", "delayed"), "getJobCounts");
    const queued = (counts.active || 0) + (counts.waiting || 0) + (counts.delayed || 0);
    subsonicOk(req, res, {
        scanStatus: {
            scanning: queued > 0,
            count: queued,
        },
    });
}));

subsonicRouter.all("/startScan.view", wrap(async (req: Request, res: Response) => {
    // The REST equivalent (routes/library/scan.ts) is admin-gated via
    // requireAdmin; this one had no check at all -- any authenticated
    // Subsonic user, including a plain non-admin account, could trigger a
    // full library scan. Uses the shared helper (userHelpers.ts) rather than
    // a seventh inline copy of the check that produced that gap in the first
    // place.
    if (!requireSubsonicAdmin(req, res)) return;
    if (!config.music.musicPath) {
        return subsonicError(req, res, SubsonicError.GENERIC, "Music path not configured");
    }

    await withQueueDeadline(
        scanQueue.add("scan", {
            userId: req.user!.id,
            musicPath: config.music.musicPath,
        }),
        "scanQueue.add"
    );

    const counts = await withQueueDeadline(scanQueue.getJobCounts("active", "waiting", "delayed"), "getJobCounts");
    const queued = (counts.active || 0) + (counts.waiting || 0) + (counts.delayed || 0);

    subsonicOk(req, res, {
        scanStatus: {
            scanning: true,
            count: queued,
        },
    });
}));

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
