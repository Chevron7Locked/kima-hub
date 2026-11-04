import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { isFileGone } from "../../utils/errors";
import { config } from "../../config";
import { getAudioStreamingService, isQuality } from "../../services/audioStreaming";
import { resolveWithinMusicRoot } from "./trackPath";
import path from "path";


type StreamableTrack = { id: string; filePath: string; fileModified: Date };

// Shared by the primary quality attempt and the FFMPEG_NOT_FOUND fallback:
// resolves the track's on-disk path (rejecting any escape from the music
// root) and streams it at the given quality.
async function resolveAndStream(
  track: StreamableTrack,
  quality: string,
  req: Request,
  res: Response,
): Promise<void> {
  const absolutePath = resolveWithinMusicRoot(track.filePath);
  if (!absolutePath) {
    logger.warn(`[STREAM] Rejected out-of-root path for track ${track.id}`);
    res.status(404).json({ error: "Track not available" });
    return;
  }

  const streamingService = getAudioStreamingService(
    config.music.transcodeCachePath,
    config.music.transcodeCacheMaxGb,
  );

  logger.debug(
    `[STREAM] Using native file: ${track.filePath} (${quality})`,
  );

  const { filePath, mimeType } = await streamingService.getStreamFilePath(
    track.id,
    quality as any,
    track.fileModified,
    absolutePath,
  );

  logger.debug(`[STREAM] Sending file: ${filePath}, mimeType: ${mimeType}`);

  await streamingService.streamFileWithRangeSupport(req, res, filePath, mimeType);

  logger.debug(`[STREAM] File sent successfully: ${path.basename(filePath)}`);
}

const router = Router();

router.get("/tracks/:id/stream", async (req, res) => {
  try {
    logger.debug("[STREAM] Request received for track:", req.params.id);
    const { quality } = req.query;
    const userId = req.user?.id;

    if (quality !== undefined && !isQuality(quality)) {
      return res.status(400).json({ error: "quality must be original, high, medium or low" });
    }

    if (!userId) {
      logger.debug("[STREAM] No userId in session - unauthorized");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Track lookup and the quality setting are independent: fetch in parallel so
    // they cost one round-trip, not two, before the first byte. Only read
    // settings when the request did not pin a quality (it usually does not).
    const [track, settings] = await Promise.all([
      prisma.track.findUnique({ where: { id: req.params.id } }),
      quality
        ? Promise.resolve(null)
        : prisma.userSettings.findUnique({ where: { userId } }),
    ]);

    if (!track) {
      logger.debug("[STREAM] Track not found");
      return res.status(404).json({ error: "Track not found" });
    }

    // The scan never deletes a vanished file's row -- it flags it. The flag,
    // not the failed open, is what answers a stream request: a clear
    // not-found instead of a generic 500.
    if (track.missingSince) {
      logger.debug(
        `[STREAM] Track ${track.id} is missing from disk (since ${track.missingSince.toISOString()})`,
      );
      return res.status(404).json({ error: "Track not available" });
    }

    // Streaming bytes is not listening: plays are recorded through POST /plays and
    // Subsonic's scrobble.view, judged in services/playRecording.ts.

    // Default to original (no transcode) to match the schema default and avoid a
    // pointless first-play transcode for users with no settings row.
    const requestedQuality: string = quality
      ? (quality as string)
      : settings?.playbackQuality || "original";

    const ext = track.filePath
      ? path.extname(track.filePath).toLowerCase()
      : "";
    logger.debug(
      `[STREAM] Quality: requested=${
        quality || "default"
      }, using=${requestedQuality}, format=${ext}`,
    );

    if (track.filePath && track.fileModified) {
      const streamableTrack: StreamableTrack = {
        id: track.id,
        filePath: track.filePath,
        fileModified: track.fileModified,
      };

      try {
        await resolveAndStream(streamableTrack, requestedQuality, req, res);
        return;
      } catch (err: any) {
        if (
          err.code === "FFMPEG_NOT_FOUND" &&
          requestedQuality !== "original"
        ) {
          logger.warn(
            `[STREAM] FFmpeg not available, falling back to original quality`,
          );
          await resolveAndStream(streamableTrack, "original", req, res);
          return;
        }
        throw err;
      }
    }

    logger.debug("[STREAM] Track has no file path - unavailable");
    return res.status(404).json({ error: "Track not available" });
  } catch (error) {
    // The file went between the last scan and this request; the next scan flags it.
    if (isFileGone(error)) {
      return res.status(404).json({ error: "Track not available" });
    }
    logger.error("Stream track error:", error);
    res.status(500).json({ error: "Failed to stream track" });
  }
});

router.post("/tracks/:id/prewarm", async (req, res) => {
  try {
    const { quality } = req.query;
    const userId = req.user?.id;

    if (quality !== undefined && !isQuality(quality)) {
      return res.status(400).json({ error: "quality must be original, high, medium or low" });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [track, settings] = await Promise.all([
      prisma.track.findUnique({ where: { id: req.params.id } }),
      quality
        ? Promise.resolve(null)
        : prisma.userSettings.findUnique({ where: { userId } }),
    ]);

    if (!track) {
      return res.status(404).json({ error: "Track not found" });
    }

    if (!track.filePath || !track.fileModified || track.missingSince) {
      return res.status(202).json({ ok: true });
    }

    const requestedQuality: string = quality
      ? (quality as string)
      : settings?.playbackQuality || "original";

    const absolutePath = resolveWithinMusicRoot(track.filePath);
    if (!absolutePath) {
      logger.warn(`[STREAM] Rejected out-of-root path for track ${track.id}`);
      return res.status(202).json({ ok: true });
    }

    const streamingService = getAudioStreamingService(
      config.music.transcodeCachePath,
      config.music.transcodeCacheMaxGb,
    );

    // Fire-and-forget at low priority so on-demand streams always preempt.
    void streamingService.getStreamFilePath(
      track.id,
      requestedQuality as any,
      track.fileModified,
      absolutePath,
      -1,
    ).catch(() => {});

    return res.status(202).json({ ok: true });
  } catch (error) {
    logger.error("Prewarm track error:", error);
    res.status(500).json({ error: "Failed to prewarm track" });
  }
});

export default router;
