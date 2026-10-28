import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { subsonicError, subsonicOk, SubsonicError } from "../../utils/subsonicResponse";
import { DIRECT_PARAMS, knownSuffix, parseRepeatedQueryParam, songFormat, transcodeParamsFor, wrap } from "./mappers";
import { planSubsonicSong } from "./streamPlan";
import { resolveWithinMusicRoot } from "../library/trackPath";
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

// Endpoints Kima does not implement answer with a real Subsonic error, never
// a hollow "ok": a client told "ok" shows the user state the server never stored.

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

// Creates a real share link through the web route's service. wrap() is
// required: the lookups below run outside the try, and Express 4 sends no
// response for a rejected handler promise.
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
    } catch (error) {
        if (error instanceof ShareError) {
            return shareFailure(req, res, error);
        }
        // Any other error is ours: answer with the generic code and a fixed string,
        // since a Prisma message names tables and columns. The stack goes to the log.
        logger.error(
            `[Subsonic] createShare failed: ${
                error instanceof Error ? error.stack : String(error)
            }`
        );
        return subsonicError(req, res, SubsonicError.GENERIC, "Failed to create share");
    }
}));

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

// No chat model, so an empty list; accepting and discarding a message is not an option.
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

// Jukebox mode plays on the server's own audio output, which Kima has none of.
compatRouter.all("/jukeboxControl.view", (req: Request, res: Response) => {
    const action = (req.query.action as string | undefined)?.toLowerCase();
    if (!action) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: action");
    }
    return notSupported(req, res, "Jukebox mode");
});

// Answers from the track's real format. Kima transcodes only to MP3, so any other
// asked-for format that is not the source's own can neither play directly nor be made.
compatRouter.all("/getTranscodeDecision.view", wrap(async (req: Request, res: Response) => {
    const mediaId = req.query.mediaId as string | undefined;
    const mediaType = req.query.mediaType as string | undefined;
    if (!mediaId) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaId");
    }
    if (!mediaType) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaType");
    }

    const format = req.query.format as string | undefined;
    const wanted = format?.toLowerCase();

    // A podcast episode is served from its own feed as it is (getTranscodeStream redirects to it), never transcoded.
    if (mediaType.toLowerCase() === "podcast") {
        const episode = await prisma.podcastEpisode.findUnique({ where: { id: mediaId }, select: { mimeType: true } });
        if (!episode) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Media not found");
        }
        const source = knownSuffix(episode.mimeType);
        const asIs = !wanted || wanted === "raw" || wanted === source;
        return subsonicOk(req, res, {
            transcodeDecision: {
                canDirectPlay: asIs,
                canTranscode: false,
                transcodeReason: asIs ? [] : [`episode is ${source ?? "of unknown format"}, client asked for ${wanted}`],
                errorReason: asIs ? "" : "Kima plays podcast episodes as their feed serves them",
                ...(asIs && { transcodeParams: DIRECT_PARAMS }),
            },
        });
    }

    if (mediaType.toLowerCase() !== "song") {
        return subsonicError(req, res, SubsonicError.GENERIC, "Unsupported mediaType");
    }

    const track = await prisma.track.findUnique({
        where: { id: mediaId },
        select: { filePath: true, mime: true },
    });
    const absolutePath = track?.filePath ? resolveWithinMusicRoot(track.filePath) : null;
    if (!track || !absolutePath) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Media not found");
    }

    // The same plan stream.view and getTranscodeStream follow, so the stream is what this answer says.
    const source = songFormat(track);
    const plan = await planSubsonicSong(format, req.query.maxBitRate as string | undefined, track, absolutePath);
    const canDirectPlay = "direct" in plan && plan.direct;

    return subsonicOk(req, res, {
        transcodeDecision: {
            canDirectPlay,
            canTranscode: !("refused" in plan),
            transcodeReason: canDirectPlay
                ? []
                : [wanted && wanted !== source ? `source is ${source || "unknown"}, client asked for ${wanted}` : `client capped the bitrate at ${req.query.maxBitRate}`],
            errorReason: "refused" in plan ? plan.refused : "",
            // Direct play still gets a value: getTranscodeStream requires one.
            ...(canDirectPlay && { transcodeParams: DIRECT_PARAMS }),
            ...("serve" in plan && { transcodeParams: transcodeParamsFor(plan.serve) }),
        },
    });
}));