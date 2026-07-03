import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { getAudioStreamingService } from "../../services/audioStreaming";
import { resolveTrackFilePath } from "./trackPath";
import path from "path";

// Play-logging dedup window. The DB recent-play check + insert now run
// off the critical path (fire-and-forget), so two concurrent stream requests
// for the same track could both see "no recent play" and both insert. A
// synchronous in-process claim closes that race: it is checked-and-set before
// any await, so only the first of N concurrent requests proceeds to log.
const PLAY_LOG_WINDOW_MS = 30 * 1000;
const recentlyLoggedPlays = new Map<string, number>();
function claimPlayLog(userId: string, trackId: string): boolean {
  const key = `${userId}:${trackId}`;
  const now = Date.now();
  const last = recentlyLoggedPlays.get(key);
  if (last && now - last < PLAY_LOG_WINDOW_MS) return false;
  recentlyLoggedPlays.set(key, now);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (recentlyLoggedPlays.size > 1000) {
    for (const [k, t] of recentlyLoggedPlays) {
      if (now - t >= PLAY_LOG_WINDOW_MS) recentlyLoggedPlays.delete(k);
    }
  }
  return true;
}

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
  const absolutePath = resolveTrackFilePath(track.filePath);
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

    // Play-history logging must NOT gate the first byte -- it added two
    // sequential DB round-trips (a recent-play check + an insert) to the start
    // latency for no playback benefit. Fire it in the background, gated by a
    // synchronous in-process claim so concurrent requests can't double-insert.
    if (claimPlayLog(userId, track.id)) {
      void (async () => {
        try {
          const recentPlay = await prisma.play.findFirst({
            where: {
              userId,
              trackId: track.id,
              playedAt: { gte: new Date(Date.now() - PLAY_LOG_WINDOW_MS) },
            },
            orderBy: { playedAt: "desc" },
          });
          if (!recentPlay) {
            await prisma.play.create({ data: { userId, trackId: track.id } });
          }
        } catch (err) {
          recentlyLoggedPlays.delete(`${userId}:${track.id}`);
          logger.warn("[STREAM] Failed to log play (non-fatal):", err);
        }
      })();
    }

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

        logger.error("[STREAM] Native streaming failed:", err.message);
        return res.status(500).json({ error: "Failed to stream track" });
      }
    }

    logger.debug("[STREAM] Track has no file path - unavailable");
    return res.status(404).json({ error: "Track not available" });
  } catch (error) {
    logger.error("Stream track error:", error);
    res.status(500).json({ error: "Failed to stream track" });
  }
});

router.post("/tracks/:id/prewarm", async (req, res) => {
  try {
    const { quality } = req.query;
    const userId = req.user?.id;

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

    if (!track.filePath || !track.fileModified) {
      return res.status(202).json({ ok: true });
    }

    const requestedQuality: string = quality
      ? (quality as string)
      : settings?.playbackQuality || "original";

    const absolutePath = resolveTrackFilePath(track.filePath);
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
