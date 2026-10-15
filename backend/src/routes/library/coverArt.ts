import { Router, Response } from "express";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { imageLimiter } from "../../middleware/rateLimiter";
import { config, USER_AGENT } from "../../config";
import { findAlbumArtwork } from "../../services/artwork";
import { musicBrainzService } from "../../services/musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";
import { BlockedAddressError, fetchChecked, validateUrlForFetch } from "../../utils/ssrf";
import {
  extractColorsFromImage,
  FALLBACK_PALETTE,
} from "../../utils/colorExtractor";
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

    const ssrfError = await validateUrlForFetch(coverUrl);
    if (ssrfError) {
      logger.warn(`[COVER-ART] SSRF blocked: ${ssrfError} for ${coverUrl.substring(0, 100)}`);
      return res.status(400).json({ error: "Invalid cover art URL" });
    }

    logger.debug(`[COVER-ART] Fetching: ${coverUrl.substring(0, 100)}...`);
    let imageResponse: Awaited<ReturnType<typeof globalThis.fetch>>;
    const fetchOpts = {
      headers: { "User-Agent": USER_AGENT },
    };
    try {
      imageResponse = await fetchChecked(coverUrl, fetchOpts);
    } catch (fetchErr: unknown) {
      if (fetchErr instanceof BlockedAddressError) {
        logger.warn(`[COVER-ART] SSRF blocked: ${fetchErr.message} for ${coverUrl.substring(0, 100)}`);
        return res.status(400).json({ error: "Invalid cover art URL" });
      }
      const cause = fetchErr instanceof Error && "cause" in fetchErr ? (fetchErr.cause as { code?: string }) : null;
      const code = cause?.code;
      if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "UND_ERR_SOCKET") {
        logger.warn(`[COVER-ART] Transient error (${code}), retrying once...`);
        await new Promise(r => setTimeout(r, 500));
        imageResponse = await fetchChecked(coverUrl, fetchOpts);
      } else {
        throw fetchErr;
      }
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

router.get("/cover-art-colors", imageLimiter, async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: "URL parameter required" });
    }

    const imageUrl = decodeURIComponent(url as string);

    if (
      imageUrl.includes("placeholder") ||
      imageUrl.startsWith("/placeholder")
    ) {
      logger.debug(
        `[COLORS] Placeholder image detected, returning fallback colors`,
      );
      return res.json(FALLBACK_PALETTE);
    }

    const cacheKey = `colors:${crypto
      .createHash("md5")
      .update(imageUrl)
      .digest("hex")}`;

    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        logger.debug(`[COLORS] Cache HIT for ${imageUrl.substring(0, 60)}...`);
        return res.json(JSON.parse(cached));
      } else {
        logger.debug(
          `[COLORS] ✗ Cache MISS for ${imageUrl.substring(0, 60)}...`,
        );
      }
    } catch (cacheError) {
      logger.warn("[COLORS] Redis cache read error:", cacheError);
    }

    const ssrfError = await validateUrlForFetch(imageUrl);
    if (ssrfError) {
      logger.warn(`[COLORS] SSRF blocked: ${ssrfError} for ${imageUrl.substring(0, 100)}`);
      return res.status(400).json({ error: "Invalid image URL" });
    }

    logger.debug(`[COLORS] Fetching image: ${imageUrl.substring(0, 100)}...`);
    let imageResponse: Awaited<ReturnType<typeof fetchChecked>>;
    try {
      imageResponse = await fetchChecked(imageUrl, { headers: { "User-Agent": USER_AGENT } });
    } catch (err) {
      if (!(err instanceof BlockedAddressError)) throw err;
      logger.warn(`[COLORS] SSRF blocked: ${err.message} for ${imageUrl.substring(0, 100)}`);
      return res.status(400).json({ error: "Invalid image URL" });
    }

    if (!imageResponse.ok) {
      logger.error(
        `[COLORS] Failed to fetch image: ${imageUrl} (${imageResponse.status})`,
      );
      return res.status(404).json({ error: "Image not found" });
    }

    const buffer = await imageResponse.arrayBuffer();
    const imageBuffer = Buffer.from(buffer);

    const colors = await extractColorsFromImage(imageBuffer);

    logger.debug(`[COLORS] Extracted colors:`, colors);

    try {
      await redisClient.setex(
        cacheKey,
        30 * 24 * 60 * 60,
        JSON.stringify(colors),
      );
      logger.debug(`[COLORS] Cached colors for 30 days`);
    } catch (cacheError) {
      logger.warn("[COLORS] Redis cache write error:", cacheError);
    }

    res.json(colors);
  } catch (error) {
    logger.error("Extract colors error:", error);
    res.status(500).json({ error: "Failed to extract colors" });
  }
});

export default router;
