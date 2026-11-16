import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import { imageLimiter } from "../../middleware/rateLimiter";
import { USER_AGENT } from "../../config";
import { findAlbumArtwork } from "../../services/artwork";
import { notePictureChange } from "../../services/shownChanges";
import { musicBrainzService } from "../../services/musicbrainz";
import { getSystemSettings } from "../../utils/systemSettings";
import { BlockedAddressError, InvalidAddressError, fetchChecked } from "../../utils/ssrf";
import { upstreamFailure, upstreamStatusFailure } from "../../utils/upstream";
import {
  resizeImageBuffer,
  coverFileForSize,
  coverWidthOf,
  resolveInCoversDir,
  coverCacheControl,
  parseStoredCover,
  readPicture,
} from "../../services/imageStorage";
import { sendStoredFile } from "../../utils/sendStoredFile";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { refuseRequest } from "../../utils/errors";

/** A picture at another address never changes there, so it is kept for good. */
const FIXED_PICTURE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * A copy found instead of a stored cover whose file is gone: the album now points at it, but the stored cover's address
 * (a versioned one reads "this picture for good") must not keep it for a year, since the file may come back.
 */
const FALLBACK_CACHE_CONTROL = "public, max-age=300";

/**
 * Every cover answer's headers: readable from any page (with credentials for a named origin). A picture fetched from
 * another address is cached for good; a stored cover is too when its address carries a version, and is asked about again
 * each time when it does not (see `coverCacheControl`).
 */
function coverHeaders(origin: string | undefined, cacheControl = FIXED_PICTURE_CACHE_CONTROL): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    ...(origin ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": cacheControl,
  };
}

async function serveNativeImage(
  coverCachePath: string,
  nativePath: string,
  version: string | null,
  size: string | undefined,
  req: Request,
  res: Response,
) {
  const headers = { "Content-Type": "image/jpeg", ...coverHeaders(req.headers.origin, coverCacheControl(version)) };

  // A stored file that cannot be sent (deleted since the caller looked) is a 404, not Express's default error page.
  const send = (file: string) =>
    sendStoredFile(res, file, { headers }, () => void res.status(404).json({ error: "Cover art not found" }));

  return send(await coverFileForSize(coverCachePath, nativePath, size));
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
    return refuseRequest(req, res, "audiobook cover path: not an items/<id>/cover path");
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
    if (upstreamStatusFailure(imageResponse.status) === "down") {
      return res.status(502).json({ error: "Audiobookshelf did not answer; try again shortly" });
    }
    return res.status(404).json({ error: "Audiobook cover art not found" });
  }

  const picture = await readPicture(imageResponse);
  if (!picture) {
    logger.warn(`[COVER-ART] Audiobook cover ${coverUrl} is over the size cap or no image; not sent`);
    return res.status(404).json({ error: "Audiobook cover art not found" });
  }

  res.setHeader("Content-Type", picture.contentType);
  res.set(coverHeaders(req.headers.origin));

  return res.send(picture.bytes);
}

/**
 * A cover stored in the covers folder: 400 for a path outside it. When the file is gone, the album it belonged to is
 * looked up in every artwork source, and what is found is remembered and returned for the caller to serve through
 * Kima (never a redirect off-site: the web app's service worker may only fetch Kima itself); otherwise 404.
 * Returns the address to serve, or null once it has answered.
 */
async function serveStoredCover(address: string, size: string | undefined, req: Request, res: Response): Promise<string | null> {
  const { relativePath: nativePath, version } = parseStoredCover(address)!;
  const file = resolveInCoversDir(nativePath);
  if (!file) {
    refuseRequest(req, res, "cover path: outside the covers folder");
    return null;
  }
  if (fs.existsSync(file)) {
    await serveNativeImage(file, nativePath, version, size, req, res);
    return null;
  }

  logger.warn(`[COVER-ART] Stored cover not found: ${file}, asking the artwork sources`);
  // The file is named for its album, under albums/ (or, for a cover stored without one, in the covers folder itself).
  const albumId = path.basename(nativePath, ".jpg");
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
        // Remembered only on the album whose cover this path is, whatever version its address carries.
        const stored = await prisma.album.updateMany({
          where: {
            id: albumId,
            OR: [{ coverUrl: `native:${nativePath}` }, { coverUrl: { startsWith: `native:${nativePath}?v=` } }],
          },
          data: { coverUrl: found.url },
        });
        if (stored.count > 0) {
          notePictureChange("album", albumId, { was: album.coverUrl, now: found.url, own: album.userCoverUrl });
        }
        return found.url;
      }
    }
  } catch (error) {
    logger.error(`[COVER-ART] Artwork lookup for ${albumId} failed:`, error);
  }
  res.status(404).json({ error: "Cover art not found" });
  return null;
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
      return refuseRequest(req, res, "cover id or url required");
    }

    if (address.startsWith("audiobook__")) {
      return serveAudiobookCover(address.replace("audiobook__", ""), req, res);
    }
    let coverUrl = address;
    let cacheControl = FIXED_PICTURE_CACHE_CONTROL;
    if (address.startsWith("native:")) {
      const found = await serveStoredCover(address, size, req, res);
      if (!found) return;
      coverUrl = found;
      cacheControl = FALLBACK_CACHE_CONTROL;
    } else if (!queryUrl && !address.startsWith("http://") && !address.startsWith("https://")) {
      // A path id is a picture's address or nothing; a query url is fetched and checked by the address guard.
      return refuseRequest(req, res, "cover id: not an address or a stored cover");
    }

    // The width as stored covers read it, so sizes that are no width share the one entry for the whole picture.
    const width = coverWidthOf(size);
    const cacheKey = `cover-art:${crypto
      .createHash("md5")
      .update(`${coverUrl}-${width ?? "original"}`)
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
        res.set({ ...coverHeaders(req.headers.origin, cacheControl), ETag: cachedData.etag });
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

      if (upstreamStatusFailure(imageResponse.status) === "down") {
        return res.status(502).json({ error: "The picture's host did not answer; try again shortly" });
      }
      return res.status(404).json({ error: "Cover art not found" });
    }
    logger.debug(`[COVER-ART] Successfully fetched, caching...`);

    const picture = await readPicture(imageResponse);
    if (!picture) {
      logger.warn(`[COVER-ART] ${coverUrl.substring(0, 100)} is over the size cap or no image; not sent`);
      return res.status(404).json({ error: "Cover art not found" });
    }
    let imageBuffer = picture.bytes;
    // A resized copy is a JPEG; a picture sent as it came keeps the type its host named.
    let contentType = picture.contentType;
    if (width) {
      imageBuffer = await resizeImageBuffer(imageBuffer, width);
      if (imageBuffer !== picture.bytes) contentType = "image/jpeg";
    }

    const etag = crypto.createHash("md5").update(imageBuffer).digest("hex");

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
    res.set({ ...coverHeaders(req.headers.origin, cacheControl), ETag: etag });

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
