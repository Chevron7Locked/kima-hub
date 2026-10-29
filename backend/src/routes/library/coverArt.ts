import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { imageLimiter } from "../../middleware/rateLimiter";
import { USER_AGENT } from "../../config";
import { findAlbumArtwork } from "../../services/artwork";
import { musicBrainzService } from "../../services/musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";
import { BlockedAddressError, InvalidAddressError, fetchChecked } from "../../utils/ssrf";
import { upstreamFailure } from "../../utils/upstream";
import {
  resizeImageBuffer,
  getResizedImagePath,
  resolveInCoversDir,
} from "../../services/imageStorage";
import crypto from "crypto";
import fs from "fs";

/** Every cover answer's headers: readable from any page (with credentials for a named origin), cached for good. */
function coverHeaders(origin: string | undefined): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    ...(origin ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "public, max-age=31536000, immutable",
  };
}

async function serveNativeImage(
  coverCachePath: string,
  nativePath: string,
  size: string | undefined,
  req: Request,
  res: Response,
) {
  const headers = { "Content-Type": "image/jpeg", ...coverHeaders(req.headers.origin) };

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

/** The only Audiobookshelf address this route asks for: a book's cover (what the audiobook sync stores). */
const AUDIOBOOK_COVER_PATH = /^items\/[A-Za-z0-9_-]+\/cover$/;

async function serveAudiobookCover(
  audiobookPath: string,
  req: Request,
  res: Response,
) {
  // The request carries Audiobookshelf's key, so nothing but a cover is ever asked for.
  if (!AUDIOBOOK_COVER_PATH.test(audiobookPath)) {
    return res.status(400).json({ error: "Invalid audiobook cover path" });
  }

  const settings = await getSystemSettings();
  const audiobookshelfUrl =
    settings?.audiobookshelfUrl || process.env.AUDIOBOOKSHELF_URL || "";
  const audiobookshelfApiKey =
    settings?.audiobookshelfApiKey || process.env.AUDIOBOOKSHELF_API_KEY || "";
  let coverUrl: string;
  try {
    coverUrl = new URL(audiobookPath, new URL(`${audiobookshelfUrl.replace(/\/$/, "")}/api/`)).href;
  } catch {
    return res.status(404).json({ error: "Audiobook cover art not found" });
  }

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
  res.set(coverHeaders(req.headers.origin));

  return res.send(imageBuffer);
}

/**
 * A cover stored in the covers folder: 400 for a path outside it. When the file is gone, the album it belonged to is
 * looked up in every artwork source, and what is found is remembered and redirected to; otherwise 404.
 */
async function serveStoredCover(nativePath: string, size: string | undefined, req: Request, res: Response) {
  const file = resolveInCoversDir(nativePath);
  if (!file) {
    return res.status(400).json({ error: "Invalid cover path" });
  }
  if (fs.existsSync(file)) {
    return serveNativeImage(file, nativePath, size, req, res);
  }

  logger.warn(`[COVER-ART] Stored cover not found: ${file}, asking the artwork sources`);
  const albumId = nativePath.replace(".jpg", "");
  try {
    const album = await prisma.album.findUnique({
      where: { id: albumId },
      include: { artist: true },
    });
    if (album?.artist) {
      const found = await findAlbumArtwork({
        rgMbid: album.rgMbid,
        artistName: album.artist.name,
        albumTitle: album.title,
      });
      if (found) {
        // Remembered only on the album whose cover this path is.
        await prisma.album.updateMany({
          where: { id: albumId, coverUrl: `native:${nativePath}` },
          data: { coverUrl: found.url },
        });
        return res.redirect(found.url);
      }
    }
  } catch (error) {
    logger.error(`[COVER-ART] Artwork lookup for ${albumId} failed:`, error);
  }
  return res.status(404).json({ error: "Cover art not found" });
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
    // Express has already decoded the query and the path once; the address is used exactly as sent.
    const size = typeof req.query.size === "string" ? req.query.size : undefined;
    const queryUrl = typeof req.query.url === "string" ? req.query.url : undefined;
    const address = queryUrl || req.params.id;
    if (!address) {
      return res.status(400).json({ error: "No cover ID or URL provided" });
    }

    if (address.startsWith("audiobook__")) {
      return serveAudiobookCover(address.replace("audiobook__", ""), req, res);
    }
    if (address.startsWith("native:")) {
      return serveStoredCover(address.replace("native:", ""), size, req, res);
    }
    // A path id is a picture's address or nothing; a query url is fetched and checked by the address guard.
    if (!queryUrl && !address.startsWith("http://") && !address.startsWith("https://")) {
      return res.status(400).json({ error: "Invalid cover ID format" });
    }
    const coverUrl = address;

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
        res.set({ ...coverHeaders(req.headers.origin), ETag: cachedData.etag });
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
    const contentType = imageResponse.headers.get("content-type");

    try {
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

    if (contentType) {
      res.setHeader("Content-Type", contentType);
    }
    res.set({ ...coverHeaders(req.headers.origin), ETag: etag });

    res.send(imageBuffer);
  } catch (error) {
    logger.error("Get cover art error:", error);
    res.status(500).json({ error: "Failed to fetch cover art" });
  }
});

router.get("/album-cover/:mbid", imageLimiter, async (req, res) => {
  try {
    const { mbid } = req.params;

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
