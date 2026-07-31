import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { subsonicError, subsonicOk, SubsonicError } from "../../utils/subsonicResponse";
import { parseRepeatedQueryParam, wrap } from "./mappers";
import {
    createShareLink,
    deleteShareLink,
    listShareLinks,
    ShareError,
    updateShareLink,
} from "../../services/shareService";
import { logger } from "../../utils/logger";

export const compatRouter = Router();

/** Map a ShareError onto the Subsonic error surface. */
function shareFailure(req: Request, res: Response, error: unknown) {
    if (error instanceof ShareError) {
        const code =
            error.code === "FORBIDDEN" ? SubsonicError.NOT_AUTHORIZED
            : error.code === "NOT_FOUND" ? SubsonicError.NOT_FOUND
            : SubsonicError.GENERIC;
        return subsonicError(req, res, code, error.message);
    }
    throw error;
}

// Endpoints Kima does not implement.
//
// They answer with a real Subsonic error and a reason, NOT a hollow "ok".
// Answering ok while discarding the request is worse than refusing: the client
// believes the operation succeeded and shows the user state the server never
// stored. That is exactly how the bookmark stubs made resume positions vanish
// -- they mounted ahead of playback.ts, won the route match, and returned "ok"
// for every createBookmark.
//
// Anything with a real backing model belongs above this line, wired to it.

/** Subsonic has no "unsupported operation" code; 0 with a reason is the convention. */
function notSupported(req: Request, res: Response, what: string) {
    return subsonicError(req, res, SubsonicError.GENERIC, `${what} is not supported by this server`);
}

compatRouter.all("/getInternetRadioStations.view", (req: Request, res: Response) => {
    subsonicOk(req, res, { internetRadioStations: {} });
});

// No internet-radio model exists, so the list is genuinely empty -- but a
// create that answers "ok" and stores nothing leaves the client showing a
// station the server has never heard of.
compatRouter.all("/createInternetRadioStation.view", (req: Request, res: Response) =>
    notSupported(req, res, "Internet radio")
);

compatRouter.all("/updateInternetRadioStation.view", (req: Request, res: Response) =>
    notSupported(req, res, "Internet radio")
);

compatRouter.all("/deleteInternetRadioStation.view", (req: Request, res: Response) =>
    notSupported(req, res, "Internet radio")
);

// Wrapped for the same reason as createShare below: the user lookup can reject
// (a dropped connection, a pool timeout), and an unwrapped rejection in
// Express 4 answers nothing at all.
compatRouter.all("/getAvatar.view", wrap(async (req: Request, res: Response) => {
    const username = req.query.username as string | undefined;
    if (!username) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: username");
    }

    const user = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
    });

    if (!user) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "User not found");
    }

    // 1x1 transparent PNG for avatar compatibility when no user avatar store exists.
    const transparentPng = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W1R0AAAAASUVORK5CYII=",
        "base64"
    );

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    return res.send(transparentPng);
}));

// Real: ShareLink backs this, so report the caller's actual live links rather
// than a permanent empty list.
compatRouter.all("/getShares.view", wrap(async (req: Request, res: Response) => {
    const links = await listShareLinks(req.user!.id);
    const base = `${req.protocol}://${req.get("host")}`;
    return subsonicOk(req, res, {
        shares: links.length
            ? {
                  share: links.map((l) => ({
                      "@_id": l.token,
                      "@_url": `${base}/share/${l.token}`,
                      "@_username": req.user!.username,
                      "@_created": l.createdAt.toISOString(),
                      "@_expires": l.expiresAt?.toISOString(),
                      "@_visitCount": l.playCount,
                  })),
              }
            : {},
    });
}));

// Creates a REAL share link through the same service the web route uses.
//
// This used to fabricate one: a synthetic `kima-<timestamp>` id and a URL
// pointing at `/share/unsupported`, a path that does not exist. A client handed
// the user a link that was dead on arrival, which is worse than refusing.
// wrap() is load-bearing, not decoration: the three lookups below run OUTSIDE
// the try, and in Express 4 a rejected handler promise produces no response at
// all -- the client waits until it times out. Every sibling subsonic router
// wraps for this reason; this file was left bare.
compatRouter.all("/createShare.view", wrap(async (req: Request, res: Response) => {
    const ids = parseRepeatedQueryParam(req.query.id);
    if (ids.length === 0) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    // Subsonic ids are opaque; resolve what each one actually is. Only the
    // first is shared -- ShareLink covers a single entity.
    const [id] = ids;
    const [track, album, playlist] = await Promise.all([
        prisma.track.findUnique({ where: { id }, select: { id: true } }),
        prisma.album.findUnique({ where: { id }, select: { id: true } }),
        prisma.playlist.findUnique({ where: { id }, select: { id: true } }),
    ]);
    const entityType = track ? "track" : album ? "album" : playlist ? "playlist" : null;

    if (!entityType) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Item not found");
    }

    try {
        const share = await createShareLink(req.user!.id, entityType, id);
        const base = `${req.protocol}://${req.get("host")}`;
        return subsonicOk(req, res, {
            shares: {
                share: [
                    {
                        "@_id": share.token,
                        "@_url": `${base}${share.url}`,
                        "@_description": (req.query.description as string | undefined) || undefined,
                        "@_username": req.user!.username,
                        "@_created": new Date().toISOString(),
                        "@_visitCount": 0,
                    },
                ],
            },
        });
    } catch (error: any) {
        if (error instanceof ShareError) {
            const code =
                error.code === "FORBIDDEN" ? SubsonicError.NOT_AUTHORIZED
                : error.code === "NOT_FOUND" ? SubsonicError.NOT_FOUND
                : SubsonicError.GENERIC;
            return subsonicError(req, res, code, error.message);
        }
        // Anything that is not a ShareError is ours, not the caller's. Answer
        // with the protocol's generic code and a fixed string rather than
        // rethrowing: a Prisma failure's message names tables and columns, and
        // this text goes to the client. The detail goes to the log as a stack,
        // which carries no `config` or query payload with it.
        logger.error(
            `[Subsonic] createShare failed: ${
                error instanceof Error ? error.stack : String(error)
            }`
        );
        return subsonicError(req, res, SubsonicError.GENERIC, "Failed to create share");
    }
}));

// Real. These used to validate `id`, answer ok and do nothing, so a client
// could "revoke" a share that stayed live.
compatRouter.all("/updateShare.view", wrap(async (req: Request, res: Response) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    // Subsonic sends expires as epoch millis; 0 means "never".
    const raw = req.query.expires as string | undefined;
    let expiresAt: Date | null | undefined;
    if (raw !== undefined && raw !== "") {
        const ms = Number(raw);
        if (!Number.isFinite(ms)) {
            return subsonicError(req, res, SubsonicError.MISSING_PARAM, "expires must be a number");
        }
        expiresAt = ms === 0 ? null : new Date(ms);
    }

    try {
        await updateShareLink(req.user!.id, id, { expiresAt });
        return subsonicOk(req, res);
    } catch (error) {
        return shareFailure(req, res, error);
    }
}));

compatRouter.all("/deleteShare.view", wrap(async (req: Request, res: Response) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }
    try {
        await deleteShareLink(req.user!.id, id);
        return subsonicOk(req, res);
    } catch (error) {
        return shareFailure(req, res, error);
    }
}));

// No chat model. The empty list is honest; accepting a message and discarding
// it is not -- the sender saw it "send" and nobody would ever receive it.
compatRouter.all("/getChatMessages.view", (req: Request, res: Response) => {
    subsonicOk(req, res, { chatMessages: {} });
});

compatRouter.all("/addChatMessage.view", (req: Request, res: Response) =>
    notSupported(req, res, "Chat")
);

compatRouter.all("/getVideos.view", (req: Request, res: Response) => {
    subsonicOk(req, res, { videos: {} });
});

compatRouter.all("/getVideoInfo.view", (req: Request, res: Response) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }
    subsonicOk(req, res, { videoInfo: {} });
});

compatRouter.all("/getCaptions.view", (req: Request, res: Response) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    // There is no caption store. An empty body under a captions content-type
    // reads to the client as "this video has no subtitles", which is a
    // different claim from "this server does not do captions".
    return subsonicError(req, res, SubsonicError.NOT_FOUND, "No captions available");
});

// Jukebox mode is server-side playback: the SERVER drives audio hardware. Kima
// has no such output, so every action -- start, stop, set, skip -- used to
// return a hardcoded "not playing" status as though it had been carried out.
compatRouter.all("/jukeboxControl.view", (req: Request, res: Response) => {
    const action = (req.query.action as string | undefined)?.toLowerCase();
    if (!action) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: action");
    }
    return notSupported(req, res, "Jukebox mode");
});

// Answers from the track's real format instead of claiming canDirectPlay for
// every id regardless of what it is. A blanket "direct play" told clients they
// could stream formats they cannot decode.
compatRouter.all("/getTranscodeDecision.view", wrap(async (req: Request, res: Response) => {
    const mediaId = req.query.mediaId as string | undefined;
    const mediaType = req.query.mediaType as string | undefined;
    if (!mediaId) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaId");
    }
    if (!mediaType) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaType");
    }

    const track = await prisma.track.findUnique({
        where: { id: mediaId },
        select: { mime: true },
    });
    if (!track) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Media not found");
    }

    // What the client asked to be given, if it said.
    const wanted = (req.query.format as string | undefined)?.toLowerCase();
    const source = (track.mime || "").toLowerCase();
    const canDirectPlay = !wanted || wanted === "raw" || wanted === source;

    return subsonicOk(req, res, {
        transcodeDecision: {
            canDirectPlay,
            canTranscode: true,
            transcodeReason: canDirectPlay ? [] : [`source is ${source || "unknown"}, client asked for ${wanted}`],
            errorReason: "",
            transcodeParams: canDirectPlay ? "" : `format=${wanted}`,
        },
    });
}));