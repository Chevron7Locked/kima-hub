import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { subsonicAuth } from "../../middleware/subsonicAuth";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";

import { libraryRouter } from "./library";
import { playbackRouter } from "./playback";
// Sub-routers are added in later phases (uncomment as they are implemented):
import { searchRouter } from "./search";
// import { playlistRouter } from "./playlists";
// import { userRouter } from "./user";

export const subsonicRouter = Router();

// Rate limit the Subsonic API separately: auth does a DB query on every request
const subsonicLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300, // 300 req/min per IP — enough for library sync, not brute-force
    standardHeaders: true,
    legacyHeaders: false,
});
subsonicRouter.use(subsonicLimiter);

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
        ],
    });
});

// Sub-routers mounted here (uncomment as phases complete):
subsonicRouter.use(libraryRouter);
subsonicRouter.use(playbackRouter);
subsonicRouter.use(searchRouter);
// subsonicRouter.use(playlistRouter);
// subsonicRouter.use(userRouter);

// Catch-all: inform clients that an endpoint isn't implemented yet
subsonicRouter.all("*", (req: Request, res: Response) => {
    subsonicError(req, res, SubsonicError.GENERIC, `Not implemented: ${req.path}`);
});
