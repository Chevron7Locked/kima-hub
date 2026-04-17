import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { ListenSource } from "@prisma/client";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { getAudioStreamingService } from "../../services/audioStreaming";
import { config } from "../../config";
import { bitrateToQuality, firstArtistGenre, mapSong, wrap } from "./mappers";
import { normalizeArtistName } from "../../utils/artistNormalization";

export const playbackRouter = Router();

async function streamTrackById(
    req: Request,
    res: Response,
    id: string,
    quality: "original" | "high" | "medium" | "low"
) {
    const track = await prisma.track.findUnique({ where: { id } });
    if (!track || !track.filePath) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const normalizedFilePath = track.filePath.replace(/\\/g, "/");
    const resolvedMusicPath = path.resolve(config.music.musicPath);
    const absolutePath = path.resolve(resolvedMusicPath, normalizedFilePath);

    if (!absolutePath.startsWith(resolvedMusicPath + path.sep)) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const streamingService = getAudioStreamingService(
        config.music.musicPath,
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );

    const { filePath, mimeType } = await streamingService.getStreamFilePath(
        track.id,
        quality,
        track.fileModified,
        absolutePath,
    );
    await streamingService.streamFileWithRangeSupport(req, res, filePath, mimeType);
}

// ===================== NOW PLAYING =====================

playbackRouter.all("/getNowPlaying.view", wrap(async (req, res) => {
    const staleCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const states = await prisma.playbackState.findMany({
        where: {
            playbackType: "track",
            trackId: { not: null },
            updatedAt: { gte: staleCutoff },
        },
        include: {
            user: { select: { username: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
    });

    const trackIds = states
        .map((state) => state.trackId)
        .filter((trackId): trackId is string => Boolean(trackId));

    const tracks = trackIds.length > 0
        ? await prisma.track.findMany({
              where: { id: { in: trackIds } },
              include: {
                  album: {
                      include: {
                          artist: {
                              select: {
                                  id: true,
                                  name: true,
                                  displayName: true,
                                  genres: true,
                                  userGenres: true,
                              },
                          },
                      },
                  },
              },
          })
        : [];

    const trackById = new Map(tracks.map((track) => [track.id, track]));

    const entries = states.flatMap((state) => {
        if (!state.trackId) return [];
        const track = trackById.get(state.trackId);
        if (!track) return [];

        const artistName = track.album.artist.displayName || track.album.artist.name;
        const genre = firstArtistGenre(track.album.artist.genres, track.album.artist.userGenres);
        const minutesAgo = Math.max(0, Math.floor((Date.now() - state.updatedAt.getTime()) / 60000));

        return [{
            ...mapSong(track, track.album, artistName, track.album.artist.id, genre),
            "@_username": state.user.username,
            "@_minutesAgo": minutesAgo,
            "@_playerName": "Kima",
            "@_playerId": 0,
        }];
    });

    return subsonicOk(req, res, {
        nowPlaying: entries.length > 0 ? { entry: entries } : {},
    });
}));

// ===================== STREAMING =====================

playbackRouter.all(["/hls.view", "/hls.m3u8"], wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const streamParams = new URLSearchParams();
    streamParams.set("id", id);

    const bitRateRaw = req.query.bitRate;
    const firstBitRate = Array.isArray(bitRateRaw) ? bitRateRaw[0] : bitRateRaw;
    if (typeof firstBitRate === "string" && firstBitRate.trim()) {
        const numeric = firstBitRate.split("@")[0];
        streamParams.set("maxBitRate", numeric);
    }

    for (const passthroughKey of ["u", "p", "t", "s", "v", "c", "f", "apiKey"]) {
        const value = req.query[passthroughKey];
        if (typeof value === "string" && value.length > 0) {
            streamParams.set(passthroughKey, value);
        }
    }

    const streamUrl = `${req.protocol}://${req.get("host")}/rest/stream.view?${streamParams.toString()}`;
    const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:-1,${id}\n${streamUrl}\n`;

    res.set("Content-Type", "application/vnd.apple.mpegurl");
    return res.send(playlist);
}));

playbackRouter.all("/getTranscodeStream.view", wrap(async (req, res) => {
    const mediaId = req.query.mediaId as string | undefined;
    const mediaType = (req.query.mediaType as string | undefined)?.toLowerCase();
    const transcodeParams = req.query.transcodeParams as string | undefined;

    if (!mediaId) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaId");
    }
    if (!mediaType) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: mediaType");
    }
    if (!transcodeParams) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: transcodeParams");
    }

    if (mediaType === "song") {
        const quality = bitrateToQuality(req.query.maxBitRate as string | undefined);
        return streamTrackById(req, res, mediaId, quality);
    }

    if (mediaType === "podcast") {
        const episode = await prisma.podcastEpisode.findUnique({
            where: { id: mediaId },
            select: { audioUrl: true },
        });
        if (!episode?.audioUrl) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Podcast episode not found");
        }
        return res.redirect(302, episode.audioUrl);
    }

    return subsonicError(req, res, SubsonicError.GENERIC, "Unsupported mediaType");
}));

playbackRouter.all("/stream.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const format = req.query.format as string | undefined;
    const quality = format === "raw"
        ? "original"
        : bitrateToQuality(req.query.maxBitRate as string | undefined);

    // Play logging is handled exclusively by scrobble.view to avoid double-counting.
    // Subsonic clients call scrobble.view on track completion; logging here would produce
    // two Play rows per listen for clients that implement both behaviors (Symfonium, DSub).

    await streamTrackById(req, res, id, quality);
}));

playbackRouter.all("/download.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const track = await prisma.track.findUnique({ where: { id } });
    if (!track || !track.filePath) return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");

    const normalizedFilePath = track.filePath.replace(/\\/g, "/");
    const resolvedMusicPath = path.resolve(config.music.musicPath);
    const absolutePath = path.resolve(resolvedMusicPath, normalizedFilePath);

    // Security: ensure resolved path stays within the music directory
    if (!absolutePath.startsWith(resolvedMusicPath + path.sep)) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const streamingService = getAudioStreamingService(
        config.music.musicPath,
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );

    const { filePath, mimeType } = await streamingService.getStreamFilePath(
        track.id,
        "original",
        track.fileModified,
        absolutePath,
    );
    await streamingService.streamFileWithRangeSupport(req, res, filePath, mimeType);
}));

// ===================== COVER ART =====================

playbackRouter.all("/getCoverArt.view", wrap(async (req, res) => {
    const rawId = req.query.id as string;
    if (!rawId) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    // Strip client-applied prefixes (ar-, al-, tr-)
    const id = rawId.replace(/^(ar-|al-|tr-)/, "");

    let coverUrl: string | null = null;

    // Some clients pass native cover references directly as the id value
    // (e.g. id=native:artists/<file>.jpg).
    if (rawId.startsWith("native:")) {
        coverUrl = rawId;
    }

    // Try album first (most common); ar- prefix skips album lookup since that ID is an artist ID.
    // Falls through to artist/track as a cascade — clients may use any prefix for any entity.
    if (!coverUrl && !rawId.startsWith("ar-")) {
        const album = await prisma.album.findUnique({
            where: { id },
            select: { coverUrl: true, userCoverUrl: true },
        });
        if (album) {
            coverUrl = album.userCoverUrl || album.coverUrl;
        }
    }

    // Try artist
    if (!coverUrl) {
        const artist = await prisma.artist.findUnique({
            where: { id },
            select: { heroUrl: true },
        });
        if (artist) {
            coverUrl = artist.heroUrl;
        }
    }

    // Try track's album as last resort
    if (!coverUrl) {
        const track = await prisma.track.findUnique({
            where: { id },
            include: { album: { select: { coverUrl: true, userCoverUrl: true } } },
        });
        if (track?.album) {
            coverUrl = track.album.userCoverUrl || track.album.coverUrl;
        }
    }

    if (!coverUrl) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art not found");
    }

    // External URLs are publicly accessible — redirect directly
    if (coverUrl.startsWith("http://") || coverUrl.startsWith("https://")) {
        return res.redirect(302, coverUrl);
    }

    // Native paths use "native:" prefix; resolve against the covers cache directory
    if (coverUrl.startsWith("native:")) {
        const nativePath = coverUrl.slice("native:".length);
        if (!nativePath) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art not found");
        }

        const coversBase = path.resolve(config.music.transcodeCachePath, "../covers");
        const resolvedPath = path.resolve(coversBase, nativePath);

        // Security: ensure resolved path stays within the covers directory
        if (!resolvedPath.startsWith(coversBase + path.sep)) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art not found");
        }

        if (!fs.existsSync(resolvedPath)) {
            return subsonicError(req, res, SubsonicError.NOT_FOUND, "Cover art file not found");
        }

        const ext = path.extname(resolvedPath).toLowerCase();
        const contentType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.sendFile(resolvedPath);
    }

    // Unknown URL format — redirect as a last resort
    return res.redirect(302, coverUrl);
}));

// ===================== SCROBBLE =====================

playbackRouter.all("/scrobble.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const userId = req.user!.id;
    // submission=false means "now playing" notification — skip, we only record completed plays
    const submission = req.query.submission !== "false";

    if (submission) {
        const track = await prisma.track.findUnique({ where: { id }, select: { id: true } });
        if (track) {
            const timeMs = req.query.time ? parseInt(req.query.time as string, 10) : Date.now();
            const playedAt = isNaN(timeMs) ? new Date() : new Date(timeMs);
            await prisma.play
                .create({ data: { userId, trackId: id, playedAt, source: ListenSource.SUBSONIC } })
                .catch(() => {});
        }
    }

    return subsonicOk(req, res);
}));

// ===================== LYRICS =====================

// ===================== PLAY QUEUE =====================

playbackRouter.all("/savePlayQueue.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const ids = [req.query.id].flat().filter(Boolean) as string[];
    const current = (req.query.current as string) || null;
    const position = parseInt((req.query.position as string) || "0", 10) || 0;
    const changedBy = (req.query.c as string) || "";

    await prisma.subsonicPlayQueue.upsert({
        where: { userId },
        create: { userId, trackIds: ids, current, position, changedBy, changed: new Date() },
        update: { trackIds: ids, current, position, changedBy, changed: new Date() },
    });

    return subsonicOk(req, res);
}));

playbackRouter.all("/getPlayQueue.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const queue = await prisma.subsonicPlayQueue.findUnique({ where: { userId } });

    if (!queue) {
        return subsonicOk(req, res, { playQueue: {} });
    }

    const trackIds = queue.trackIds as string[];
    if (trackIds.length === 0) {
        return subsonicOk(req, res, { playQueue: {} });
    }

    const tracks = await prisma.track.findMany({
        where: { id: { in: trackIds } },
        include: { album: { include: { artist: true } } },
    });

    const trackMap = new Map(tracks.map((t) => [t.id, t]));
    const orderedEntries = trackIds
        .map((id) => trackMap.get(id))
        .filter(Boolean)
        .map((t) => {
            const artist = t!.album.artist;
            return mapSong(
                t!,
                t!.album,
                artist.displayName || artist.name,
                artist.id,
                firstArtistGenre(artist.genres, artist.userGenres),
            );
        });

    return subsonicOk(req, res, {
        playQueue: {
            "@_current": queue.current || undefined,
            "@_position": queue.position,
            "@_username": req.user!.username,
            "@_changed": queue.changed.toISOString(),
            "@_changedBy": queue.changedBy || undefined,
            entry: orderedEntries,
        },
    });
}));

// ===================== BOOKMARKS =====================

playbackRouter.all("/getBookmarks.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const bookmarks = await prisma.subsonicBookmark.findMany({
        where: { userId },
        include: { track: { include: { album: { include: { artist: true } } } } },
    });

    const bookmarkEntries = bookmarks.map((b) => {
        const track = b.track;
        const album = track.album;
        const artist = album.artist;
        return {
            "@_position": b.position,
            "@_username": req.user!.username,
            "@_comment": b.comment || undefined,
            "@_created": b.created.toISOString(),
            "@_changed": b.changed.toISOString(),
            entry: mapSong(
                track,
                album,
                artist.displayName || artist.name,
                artist.id,
                firstArtistGenre(artist.genres, artist.userGenres),
            ),
        };
    });

    return subsonicOk(req, res, {
        bookmarks: bookmarkEntries.length ? { bookmark: bookmarkEntries } : {},
    });
}));

playbackRouter.all("/createBookmark.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const id = req.query.id as string;
    const positionRaw = req.query.position as string;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    if (positionRaw === undefined || positionRaw === "") {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: position");
    }

    const position = parseInt(positionRaw, 10);
    if (isNaN(position)) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Invalid parameter: position");
    }

    const comment = (req.query.comment as string) || undefined;

    await prisma.subsonicBookmark.upsert({
        where: { userId_trackId: { userId, trackId: id } },
        create: { userId, trackId: id, position, comment: comment ?? null },
        update: { position, comment: comment ?? null, changed: new Date() },
    });

    return subsonicOk(req, res);
}));

playbackRouter.all("/deleteBookmark.view", wrap(async (req, res) => {
    const userId = req.user!.id;
    const id = req.query.id as string;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    await prisma.subsonicBookmark.deleteMany({
        where: { userId, trackId: id },
    });

    return subsonicOk(req, res);
}));

// ===================== LYRICS =====================

playbackRouter.all("/getLyrics.view", wrap(async (req, res) => {
    const artist = (req.query.artist as string | undefined)?.trim();
    const title = (req.query.title as string | undefined)?.trim();

    if (!artist && !title) {
        return subsonicOk(req, res, { lyrics: {} });
    }

    const normalizedArtist = artist ? normalizeArtistName(artist) : undefined;

    const track = await prisma.track.findFirst({
        where: {
            ...(title ? { title: { contains: title, mode: "insensitive" as const } } : {}),
            ...(normalizedArtist ? {
                album: {
                    artist: { normalizedName: normalizedArtist },
                },
            } : {}),
        },
        include: { trackLyrics: true, album: { include: { artist: true } } },
    });

    if (!track?.trackLyrics) {
        return subsonicOk(req, res, { lyrics: {} });
    }

    const lyricsText = track.trackLyrics.plain_lyrics || track.trackLyrics.synced_lyrics || undefined;
    const result: Record<string, unknown> = {
        "@_artist": track.album.artist.name,
        "@_title": track.title,
    };
    if (lyricsText) {
        result["#text"] = lyricsText;
    }

    return subsonicOk(req, res, { lyrics: result });
}));
