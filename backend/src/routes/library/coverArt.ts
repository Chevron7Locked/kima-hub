import { Router, Response } from "express";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { imageLimiter } from "../../middleware/rateLimiter";
import { config, USER_AGENT } from "../../config";
import { findAlbumArtwork } from "../../services/artwork";
import { musicBrainzService } from "../../services/musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";
import { BlockedAddressError, InvalidAddressError, fetchChecked } from "../../utils/ssrf";
import { upstreamFailure } from "../../utils/upstream";
import {
  resizeImageBuffer,
  getResizedImagePath,
} from "../../services/imageStorage";
import crypto from "crypto";
import path from "path";
import fs from "fs";

function validateCoverPath(basePath: string, userPath: string): string | null {
  const resolvedBase = path.resolve(basePath);
  const resolvedPath = path.resolve(resolvedBase, userPath);

  if (
    !resolvedPath.startsWith(resolvedBase + path.sep) &&
    resolvedPath !== resolvedBase
  ) {
    return null;
  }

  return resolvedPath;
}

const applyCoverArtCorsHeaders = (res: Response, origin?: string) => {
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
};

async function serveNativeImage(
  coverCachePath: string,
  nativePath: string,
  size: string | undefined,
  req: any,
  res: any,
): Promise<void> {
  const requestOrigin = req.headers.origin;
  const headers: Record<string, string> = {
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
  if (requestOrigin) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  } else {
    headers["Access-Control-Allow-Origin"] = "*";
  }

  const width = size ? parseInt(size, 10) : 0;

  if (!width || width < 16 || width > 2048) {
    return res.sendFile(coverCachePath, { headers });
  }

  const resizedPath = getResizedImagePath(`native:${nativePath}`, width);
  if (resizedPath && fs.existsSync(resizedPath)) {
    return res.sendFile(resizedPath, { headers });
  }

  try {
    const originalBuffer = fs.readFileSync(coverCachePath);
    const resizedBuffer = await resizeImageBuffer(originalBuffer, width);

    if (resizedPath) {
      fs.writeFileSync(resizedPath, resizedBuffer);
      return res.sendFile(resizedPath, { headers });
    }

    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    return res.send(resizedBuffer);
  } catch (err) {
    logger.warn(
      `[COVER-ART] Resize failed for ${nativePath}, serving original: ${err instanceof Error ? err.message : String(err)}`,
    );
    return res.sendFile(coverCachePath, { headers });
  }
}

async function serveAudiobookCover(
  audiobookPath: string,
  req: any,
  res: any,
): Promise<void> {
  if (audiobookPath.includes("..") || audiobookPath.includes("://")) {
    return res.status(400).json({ error: "Invalid audiobook cover path" });
  }

  const settings = await getSystemSettings();
  const audiobookshelfUrl =
    settings?.audiobookshelfUrl || process.env.AUDIOBOOKSHELF_URL || "";
  const audiobookshelfApiKey =
    settings?.audiobookshelfApiKey || process.env.AUDIOBOOKSHELF_API_KEY || "";
  const coverUrl = `${audiobookshelfUrl.replace(/\/$/, "")}/api/${audiobookPath}`;

  logger.debug(
    `[COVER-ART] Fetching audiobook cover: ${coverUrl.substring(0, 100)}...`,
  );
  const imageResponse = await fetch(coverUrl, {
    headers: {
      Authorization: `Bearer ${audiobookshelfApiKey}`,
      "User-Agent": USER_AGENT,
    },
  });

  if (!imageResponse.ok) {
    logger.error(
      `[COVER-ART] Failed to fetch audiobook cover: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`,
    );
    return res.status(404).json({ error: "Audiobook cover art not found" });
  }

  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const contentType = imageResponse.headers.get("content-type");

  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

  return res.send(imageBuffer);
}

const router = Router();

type FetchedImage = Awaited<ReturnType<typeof fetchChecked>>;

/** A picture from its host, with one more try after a dropped connection. */
async function fetchImage(url: string): Promise<FetchedImage> {
  const opts = { headers: { "User-Agent": USER_AGENT } };
  try {
    return await fetchChecked(url, opts);
  } catch (err) {
    const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code !== "ECONNRESET" && code !== "ETIMEDOUT" && code !== "UND_ERR_SOCKET") throw err;
    logger.warn(`[COVER-ART] Transient error (${code}), retrying once...`);
    await new Promise((r) => setTimeout(r, 500));
    return fetchChecked(url, opts);
  }
}

/**
 * Answers a picture fetch that failed: an address refused or not an address is the request's (400); a host with no
 * such picture is a 404 and one that does not answer a 502. Anything else is left to the route.
 */
function answerImageFetchFailure(
  res: Response,
  err: unknown,
  label: string,
  url: string,
  messages: { invalid: string; missing: string },
): boolean {
  if (err instanceof BlockedAddressError || err instanceof InvalidAddressError) {
    logger.warn(`[${label}] refused: ${err.message} for ${url.substring(0, 100)}`);
    res.status(400).json({ error: messages.invalid });
    return true;
  }
  const failure = upstreamFailure(err);
  if (failure === "missing") {
    res.status(404).json({ error: messages.missing });
    return true;
  }
  if (failure === "down") {
    logger.warn(`[${label}] host did not answer for ${url.substring(0, 100)}: ${(err as Error).message}`);
    res.status(502).json({ error: "The picture's host did not answer; try again shortly" });
    return true;
  }
  return false;
}

router.get("/cover-art/:id?", imageLimiter, async (req, res) => {
  try {
    const { size, url } = req.query;
    let coverUrl: string;

    if (url) {
      const decodedUrl = decodeURIComponent(url as string);

      if (decodedUrl.startsWith("audiobook__")) {
        return serveAudiobookCover(
          decodedUrl.replace("audiobook__", ""),
          req,
          res,
        );
      }

      if (decodedUrl.startsWith("native:")) {
        const nativePath = decodedUrl.replace("native:", "");
        const coversBase = path.resolve(
          config.music.transcodeCachePath,
          "../covers",
        );
        const coverCachePath = validateCoverPath(coversBase, nativePath);

        if (!coverCachePath) {
          return res.status(400).json({ error: "Invalid cover path" });
        }

        if (!fs.existsSync(coverCachePath)) {
          logger.error(`[COVER-ART] Native cover not found: ${coverCachePath}`);
          return res.status(404).json({ error: "Cover art not found" });
        }

        return serveNativeImage(
          coverCachePath,
          nativePath,
          size as string | undefined,
          req,
          res,
        );
      }

      coverUrl = decodedUrl;
    } else {
      const coverId = req.params.id;
      if (!coverId) {
        return res.status(400).json({ error: "No cover ID or URL provided" });
      }

      const decodedId = decodeURIComponent(coverId);

      if (decodedId.startsWith("native:")) {
        const nativePath = decodedId.replace("native:", "");
        const coversBase = path.resolve(
          config.music.transcodeCachePath,
          "../covers",
        );
        const coverCachePath = validateCoverPath(coversBase, nativePath);

        if (!coverCachePath) {
          return res.status(400).json({ error: "Invalid cover path" });
        }

        if (fs.existsSync(coverCachePath)) {
          return serveNativeImage(
            coverCachePath,
            nativePath,
            size as string | undefined,
            req,
            res,
          );
        }

        logger.warn(
          `[COVER-ART] Native cover not found: ${coverCachePath}, trying Deezer fallback`,
        );

        const albumId = nativePath.replace(".jpg", "");
        try {
          const album = await prisma.album.findUnique({
            where: { id: albumId },
            include: { artist: true },
          });

          if (album && album.artist) {
            // The stored file is gone. Ask every source rather than Deezer
            // alone, and remember whatever we find so the next request for
            // this album does not have to.
            const found = await findAlbumArtwork({
              rgMbid: album.rgMbid,
              artistName: album.artist.name,
              albumTitle: album.title,
            });

            if (found) {
              await prisma.album.update({
                where: { id: albumId },
                data: { coverUrl: found.url },
              });

              return res.redirect(found.url);
            }
          }
        } catch (error) {
          logger.error(
            `[COVER-ART] Failed to fetch Deezer fallback for ${albumId}:`,
            error,
          );
        }

        return res.status(404).json({ error: "Cover art not found" });
      }

      if (decodedId.startsWith("audiobook__")) {
        return serveAudiobookCover(
          decodedId.replace("audiobook__", ""),
          req,
          res,
        );
      } else if (
        decodedId.startsWith("http://") ||
        decodedId.startsWith("https://")
      ) {
        coverUrl = decodedId;
      } else {
        return res.status(400).json({ error: "Invalid cover ID format" });
      }
    }

    const cacheKey = `cover-art:${crypto
      .createHash("md5")
      .update(`${coverUrl}-${size || "original"}`)
      .digest("hex")}`;

    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);

        if (cachedData.notFound) {
          logger.debug(
            `[COVER-ART] Cached 404 for ${coverUrl.substring(0, 60)}...`,
          );
          return res.status(404).json({ error: "Cover art not found" });
        }

        logger.debug(
          `[COVER-ART] Cache HIT for ${coverUrl.substring(0, 60)}...`,
        );
        const imageBuffer = Buffer.from(cachedData.data, "base64");

        if (req.headers["if-none-match"] === cachedData.etag) {
          logger.debug(`[COVER-ART] Client has cached version (304)`);
          return res.status(304).end();
        }

        if (cachedData.contentType) {
          res.setHeader("Content-Type", cachedData.contentType);
        }
        applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("ETag", cachedData.etag);
        return res.send(imageBuffer);
      } else {
        logger.debug(
          `[COVER-ART] ✗ Cache MISS for ${coverUrl.substring(0, 60)}...`,
        );
      }
    } catch (cacheError) {
      logger.warn("[COVER-ART] Redis cache read error:", cacheError);
    }

    logger.debug(`[COVER-ART] Fetching: ${coverUrl.substring(0, 100)}...`);
    let imageResponse: FetchedImage;
    try {
      imageResponse = await fetchImage(coverUrl);
    } catch (fetchErr: unknown) {
      if (answerImageFetchFailure(res, fetchErr, "COVER-ART", coverUrl, { invalid: "Invalid cover art URL", missing: "Cover art not found" })) return;
      throw fetchErr;
    }
    if (!imageResponse.ok) {
      logger.error(
        `[COVER-ART] Failed to fetch: ${coverUrl} (${imageResponse.status} ${imageResponse.statusText})`,
      );

      if (imageResponse.status === 404) {
        try {
          await redisClient.setex(
            cacheKey,
            60 * 60,
            JSON.stringify({ notFound: true }),
          );
          logger.debug(`[COVER-ART] Cached 404 response for 1 hour`);
        } catch (cacheError) {
          logger.warn("[COVER-ART] Redis cache write error:", cacheError);
        }
      }

      return res.status(404).json({ error: "Cover art not found" });
    }
    logger.debug(`[COVER-ART] Successfully fetched, caching...`);

    const buffer = await imageResponse.arrayBuffer();
    let imageBuffer: Buffer = Buffer.from(buffer);

    const requestedWidth = size ? parseInt(size as string, 10) : 0;
    if (requestedWidth > 0) {
      imageBuffer = await resizeImageBuffer(imageBuffer, requestedWidth);
    }

    const etag = crypto.createHash("md5").update(imageBuffer).digest("hex");

    try {
      const contentType = imageResponse.headers.get("content-type");
      await redisClient.setex(
        cacheKey,
        7 * 24 * 60 * 60,
        JSON.stringify({
          etag,
          contentType,
          data: imageBuffer.toString("base64"),
        }),
      );
    } catch (cacheError) {
      logger.warn("Redis cache write error:", cacheError);
    }

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    const contentType = imageResponse.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }

    applyCoverArtCorsHeaders(res, req.headers.origin as string | undefined);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", etag);

    res.send(imageBuffer);
  } catch (error) {
    logger.error("Get cover art error:", error);
    res.status(500).json({ error: "Failed to fetch cover art" });
  }
});

router.get("/album-cover/:mbid", imageLimiter, async (req, res) => {
  try {
    const { mbid } = req.params;

    if (!mbid) {
      return res.status(400).json({ error: "Valid MBID required" });
    }

    // Albums the library lacks are named from MusicBrainz, since every source but the archive searches by name.
    const album = await prisma.album.findFirst({
      where: { rgMbid: mbid },
      select: { title: true, artist: { select: { name: true } } },
    });
    let artistName = album?.artist?.name ?? "";
    let albumTitle = album?.title ?? "";
    if (!album) {
      const group = await musicBrainzService.getReleaseGroup(mbid);
      if (group.kind === "answered") {
        artistName = group.value?.["artist-credit"]?.[0]?.artist?.name ?? "";
        albumTitle = group.value?.title ?? "";
      }
    }
    const found = await findAlbumArtwork({ rgMbid: mbid, artistName, albumTitle });
    const coverUrl = found?.url ?? null;

    if (!coverUrl) {
      return res.status(204).send();
    }

    res.json({ coverUrl });
  } catch (error) {
    logger.error("Get album cover error:", error);
    res.status(500).json({ error: "Failed to fetch cover art" });
  }
});

export default router;
