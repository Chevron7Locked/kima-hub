import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { subsonicError, subsonicOk, SubsonicError } from "../../utils/subsonicResponse";
import { DIRECT_PARAMS, knownSuffix, mapSong, songFormat, transcodeParamsFor, wrap } from "./mappers";
import { planSubsonicSong } from "./streamPlan";
import { shownAlbumGenres } from "../../utils/genreSql";
import { resolveWithinMusicRoot } from "../library/trackPath";
import { PLAYABLE_SONG } from "../../utils/playableSong";
import {
    createShareLink,
    deleteShareLink,
    listShareLinks,
    ShareError,
    updateShareLink,
} from "../../services/shareService";
import { logger } from "../../utils/logger";
import { one, many } from "../../utils/subsonicParams";
import { findUserByUsername, normalizeUsername } from "../../services/users/accounts";

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

/**
 * The `expires` of createShare and updateShare: epoch milliseconds, 0 meaning never. Absent or empty is `undefined`
 * (no say), 0 is null (never), anything that is not a number is refused.
 */
function parseExpires(value: unknown): { ok: true; expiresAt: Date | null | undefined } | { ok: false } {
    const raw = typeof value === "string" ? value : undefined;
    if (raw === undefined || raw === "") return { ok: true, expiresAt: undefined };
    const ms = Number(raw);
    if (!Number.isFinite(ms)) return { ok: false };
    if (ms === 0) return { ok: true, expiresAt: null };
    const date = new Date(ms);
    // A number past the range of a date (1e20) is not a date: refused like a non-number, not left to fail later.
    return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, expiresAt: date };
}

const SONG_WITH_ALBUM = { album: { include: { artist: true } } } as const;

type ShareEntityType = "track" | "album" | "playlist";

/** The playable songs a share covers, as Subsonic entries: a song itself, an album in disc and track order, a playlist by rank. */
async function shareEntries(entityType: ShareEntityType, entityId: string) {
    const tracks =
        entityType === "track"
            ? await prisma.track.findMany({ where: { id: entityId, ...PLAYABLE_SONG }, include: SONG_WITH_ALBUM })
            : entityType === "album"
            ? await prisma.track.findMany({
                  where: { albumId: entityId, ...PLAYABLE_SONG },
                  orderBy: [{ discNumber: { sort: "asc", nulls: "first" } }, { trackNo: "asc" }],
                  include: SONG_WITH_ALBUM,
              })
            : (
                  await prisma.playlistItem.findMany({
                      where: { playlistId: entityId, track: PLAYABLE_SONG },
                      orderBy: { rank: "asc" },
                      include: { track: { include: SONG_WITH_ALBUM } },
                  })
              ).map((item) => item.track);
    return tracks.map((t) => mapSong(t, t.album, t.album.artist.displayName || t.album.artist.name, t.album.artist.id, shownAlbumGenres(t.album, t.album.artist)));
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

// Accounts are managed on the web, never over Subsonic (Kevin, 2026-11-11). getUser and getUsers still answer.
compatRouter.all(
    ["/changePassword.view", "/createUser.view", "/updateUser.view", "/deleteUser.view"],
    (req: Request, res: Response) => notSupported(req, res, "Account management")
);

// Wrapped for the same reason as createShare below: the user lookup can reject
// (a dropped connection, a pool timeout), and an unwrapped rejection in
// Express 4 answers nothing at all.
compatRouter.all("/getAvatar.view", wrap(async (req: Request, res: Response) => {
    const given = one(req, "username") ?? "";
    if (!normalizeUsername(given)) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: username");
    }

    const user = await findUserByUsername(given, { id: true });

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
    const shares = await Promise.all(
        links.map(async (l) => {
            const entries = await shareEntries(l.entityType as ShareEntityType, l.entityId);
            return {
                "@_id": l.token,
                "@_url": `${base}/share/${l.token}`,
                "@_username": req.user!.username,
                "@_created": l.createdAt.toISOString(),
                "@_expires": l.expiresAt?.toISOString(),
                "@_visitCount": l.playCount,
                ...(entries.length > 0 ? { entry: entries } : {}),
            };
        })
    );
    return subsonicOk(req, res, { shares: shares.length ? { share: shares } : {} });
}));

// Creates a real share link through the web route's service. wrap() is
// required: the lookups below run outside the try, and Express 4 sends no
// response for a rejected handler promise.
compatRouter.all("/createShare.view", wrap(async (req: Request, res: Response) => {
    const ids = many(req, "id");
    if (ids.length === 0) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }
    // A share holds one item: sharing the first and dropping the rest would hand the app a link it did not ask for.
    if (ids.length > 1) {
        return subsonicError(req, res, SubsonicError.GENERIC, "a share holds one item");
    }

    const expires = parseExpires(one(req, "expires"));
    if (!expires.ok) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "expires must be a number");
    }

    // Subsonic ids are opaque; resolve what the id actually is. createShareLink
    // answers not found for a song or album with nothing to play.
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
        const share = await createShareLink(req.user!.id, entityType, id, { expiresAt: expires.expiresAt });
        const base = `${req.protocol}://${req.get("host")}`;
        const entries = await shareEntries(entityType, id);
        // The reply is the link as stored (a reused link shows its own dates and visits). No description: Kima stores none.
        return subsonicOk(req, res, {
            shares: {
                share: [
                    {
                        "@_id": share.token,
                        "@_url": `${base}${share.url}`,
                        "@_username": req.user!.username,
                        "@_created": share.createdAt.toISOString(),
                        "@_expires": share.expiresAt?.toISOString(),
                        "@_visitCount": share.playCount,
                        ...(entries.length > 0 ? { entry: entries } : {}),
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
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const expires = parseExpires(one(req, "expires"));
    if (!expires.ok) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "expires must be a number");
    }

    try {
        await updateShareLink(req.user!.id, id, { expiresAt: expires.expiresAt });
        return subsonicOk(req, res);
    } catch (error) {
        return shareFailure(req, res, error);
    }
}));

compatRouter.all("/deleteShare.view", wrap(async (req: Request, res: Response) => {
    const id = one(req, "id");
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
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }
    subsonicOk(req, res, { videoInfo: {} });
});

compatRouter.all("/getCaptions.view", (req: Request, res: Response) => {
    const id = one(req, "id");
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
    const action = one(req, "action")?.toLowerCase();
    if (!action) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: action");
    }
    return notSupported(req, res, "Jukebox mode");
});

// Answers from the track's real format. Kima transcodes only to MP3, so any other
// asked-for format that is not the source's own can neither play directly nor be made.
compatRouter.all("/getTranscodeDecision.view", wrap(async (req: Request, res: Response) => {
    const mediaId = one(req, "mediaId");
    const mediaType = one(req, "mediaType");
    if (!mediaId) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaId");
    }
    if (!mediaType) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaType");
    }

    const format = one(req, "format");
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

    const track = await prisma.track.findFirst({
        where: { id: mediaId, ...PLAYABLE_SONG },
        select: { filePath: true, mime: true, bitrate: true },
    });
    const absolutePath = track?.filePath ? resolveWithinMusicRoot(track.filePath) : null;
    if (!track || !absolutePath) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Media not found");
    }

    // The same plan stream.view and getTranscodeStream follow, so the stream is what this answer says.
    const source = songFormat(track);
    const maxBitRate = one(req, "maxBitRate");
    const plan = await planSubsonicSong(format, maxBitRate, track, absolutePath);
    const canDirectPlay = "direct" in plan && plan.direct;

    return subsonicOk(req, res, {
        transcodeDecision: {
            canDirectPlay,
            canTranscode: !("refused" in plan),
            transcodeReason: canDirectPlay
                ? []
                : [wanted && wanted !== source ? `source is ${source || "unknown"}, client asked for ${wanted}` : `client capped the bitrate at ${maxBitRate}`],
            errorReason: "refused" in plan ? plan.refused : "",
            // Direct play still gets a value: getTranscodeStream requires one.
            ...(canDirectPlay && { transcodeParams: DIRECT_PARAMS }),
            ...("serve" in plan && { transcodeParams: transcodeParamsFor(plan.serve) }),
        },
    });
}));