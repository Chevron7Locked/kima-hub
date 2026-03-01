import { Router } from "express";
import path from "path";
import fs from "fs";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { getAudioStreamingService } from "../../services/audioStreaming";
import { config } from "../../config";
import { bitrateToQuality, wrap } from "./mappers";
import { ListenSource } from "@prisma/client";

export const playbackRouter = Router();

// ===================== STREAMING =====================

playbackRouter.all("/stream.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");

    const track = await prisma.track.findUnique({ where: { id } });
    if (!track || !track.filePath) return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");

    const format = req.query.format as string | undefined;
    const quality = format === "raw"
        ? "original"
        : bitrateToQuality(req.query.maxBitRate as string | undefined);

    // Play logging is handled exclusively by scrobble.view to avoid double-counting.
    // Subsonic clients call scrobble.view on track completion; logging here would produce
    // two Play rows per listen for clients that implement both behaviors (Symfonium, DSub).

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
        quality,
        track.fileModified,
        absolutePath,
    );
    await streamingService.streamFileWithRangeSupport(req, res, filePath, mimeType);
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

    // Try album first (most common); ar- prefix skips album lookup since that ID is an artist ID.
    // Falls through to artist/track as a cascade — clients may use any prefix for any entity.
    if (!rawId.startsWith("ar-")) {
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
