import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { subsonicError, subsonicOk, SubsonicError } from "../../utils/subsonicResponse";
import { parseRepeatedQueryParam } from "./mappers";

export const compatRouter = Router();

// Stubs for endpoints not yet fully implemented.
// Return valid empty responses so strict clients (e.g. Symfonium) don't error.
compatRouter.all("/getBookmarks.view", (req: Request, res: Response) => {
    subsonicOk(req, res, { bookmarks: {} });
});

compatRouter.all("/createBookmark.view", (req: Request, res: Response) => {
    subsonicOk(req, res);
});

compatRouter.all("/deleteBookmark.view", (req: Request, res: Response) => {
    subsonicOk(req, res);
});

compatRouter.all("/getInternetRadioStations.view", (req: Request, res: Response) => {
    subsonicOk(req, res, { internetRadioStations: {} });
});

compatRouter.all("/createInternetRadioStation.view", (req: Request, res: Response) => {
    subsonicOk(req, res);
});

compatRouter.all("/updateInternetRadioStation.view", (req: Request, res: Response) => {
    subsonicOk(req, res);
});

compatRouter.all("/deleteInternetRadioStation.view", (req: Request, res: Response) => {
    subsonicOk(req, res);
});

compatRouter.all("/getAvatar.view", async (req: Request, res: Response) => {
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
});

compatRouter.all("/getShares.view", (req: Request, res: Response) => {
    subsonicOk(req, res, { shares: {} });
});

compatRouter.all("/createShare.view", (req: Request, res: Response) => {
    const ids = parseRepeatedQueryParam(req.query.id);
    if (ids.length === 0) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const created = new Date().toISOString();
    return subsonicOk(req, res, {
        shares: {
            share: [
                {
                    "@_id": `kima-${Date.now()}`,
                    "@_url": `${req.protocol}://${req.get("host")}/share/unsupported`,
                    "@_description": (req.query.description as string | undefined) || undefined,
                    "@_username": req.user!.username,
                    "@_created": created,
                    "@_visitCount": 0,
                },
            ],
        },
    });
});

compatRouter.all("/updateShare.view", (req: Request, res: Response) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }
    subsonicOk(req, res);
});

compatRouter.all("/deleteShare.view", (req: Request, res: Response) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }
    subsonicOk(req, res);
});

compatRouter.all("/getChatMessages.view", (req: Request, res: Response) => {
    subsonicOk(req, res, { chatMessages: {} });
});

compatRouter.all("/addChatMessage.view", (req: Request, res: Response) => {
    const message = req.query.message as string | undefined;
    if (!message || !message.trim()) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: message");
    }
    subsonicOk(req, res);
});

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

    const format = (req.query.format as string | undefined)?.toLowerCase();
    const contentType = format === "srt" ? "application/x-subrip" : "text/vtt; charset=utf-8";
    res.set("Content-Type", contentType);
    return res.send("");
});

compatRouter.all("/jukeboxControl.view", (req: Request, res: Response) => {
    const action = (req.query.action as string | undefined)?.toLowerCase();
    if (!action) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: action");
    }

    if (action === "get") {
        return subsonicOk(req, res, {
            jukeboxPlaylist: {
                "@_currentIndex": 0,
                "@_playing": false,
                "@_gain": 1,
                "@_position": 0,
            },
        });
    }

    return subsonicOk(req, res, {
        jukeboxStatus: {
            "@_currentIndex": 0,
            "@_playing": false,
            "@_gain": 1,
            "@_position": 0,
        },
    });
});

compatRouter.all("/getTranscodeDecision.view", (req: Request, res: Response) => {
    const mediaId = req.query.mediaId as string | undefined;
    const mediaType = req.query.mediaType as string | undefined;
    if (!mediaId) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaId");
    }
    if (!mediaType) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaType");
    }

    return subsonicOk(req, res, {
        transcodeDecision: {
            canDirectPlay: true,
            canTranscode: true,
            transcodeReason: [],
            errorReason: "",
            transcodeParams: "",
        },
    });
});