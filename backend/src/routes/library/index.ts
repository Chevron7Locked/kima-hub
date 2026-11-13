import { Router } from "express";
import { apiLimiter } from "../../middleware/rateLimiter";

import scanRouter from "./scan";
import artistsRouter from "./artists";
import albumsRouter from "./albums";
import tracksRouter from "./tracks";
import streamingRouter from "./streaming";
import coverArtRouter from "./coverArt";
import backfillRouter from "./backfill";
import waveformRouter from "./waveform";

const router = Router();

/** Whether `path` is `prefix` or lies under it, by whole segments: "/cover-art" and "/cover-art/x", not "/cover-artX". */
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

// Apply the runaway limit to routes that need it
// Skip it for cover art and the album cover search (they carry the image limit) and for streaming
router.use((req, res, next) => {
  if (under(req.path, "/cover-art") || under(req.path, "/album-cover")) {
    return next();
  }
  if (req.path.endsWith("/stream")) {   // final segment only (matches stream routes; not /tracks/stream_x)
    return next();
  }
  return apiLimiter(req, res, next);
});

router.use(scanRouter);
router.use(artistsRouter);
router.use(albumsRouter);
router.use(tracksRouter);
router.use(streamingRouter);
router.use(coverArtRouter);
router.use(backfillRouter);
router.use(waveformRouter);

export default router;
