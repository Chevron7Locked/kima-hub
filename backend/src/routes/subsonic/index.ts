import { Router, Request, Response } from "express";
import { createRateLimiter } from "../../middleware/rateLimiter";
import { subsonicAuth } from "../../middleware/subsonicAuth";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { scanQueue } from "../../workers/queues";
import { requestScan } from "../../workers/scanRequest";
import { requireSubsonicAdmin } from "./userHelpers";
import { findApiKeyUser } from "../../services/users/apiKeyStore";
// Every async handler here goes through wrap(): in Express 4 a rejected handler
// promise produces NO response, so an unwrapped await that throws leaves the
// client waiting until it times out. getScanStatus and startScan both talk to
// Redis, which being unreachable is ordinary traffic rather than an edge case.
import { wrap } from "./mappers";

/**
 * Deadline for queue calls: with Redis down ioredis queues commands instead of
 * rejecting, so without it the request never answers. A healthy read takes ~6 ms.
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

// Subsonic auth queries the database on every request. 1500 a minute per IP
// leaves room for clients such as Symfonium that sync one album per request.
const subsonicLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 1500 });
subsonicRouter.use(subsonicLimiter);

// Normalize paths: append .view suffix if missing for client compatibility.
// Some clients (e.g. Musa) send /rest/ping instead of /rest/ping.view.
subsonicRouter.use((req: Request, _res: Response, next) => {
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

    const keyUser = await findApiKeyUser(apiKey);
    if (!keyUser) {
        return subsonicError(req, res, SubsonicError.INVALID_API_KEY, "Invalid API key");
    }

    return subsonicOk(req, res, { tokenInfo: { username: keyUser.username } });
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
    // Admin only, like the REST scan route.
    if (!requireSubsonicAdmin(req, res)) return;

    await withQueueDeadline(
        requestScan({ userId: req.user!.id, source: "subsonic-scan" }),
        "requestScan"
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
