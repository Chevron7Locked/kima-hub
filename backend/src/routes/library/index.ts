import { Router } from "express";
import { requireAuthOrToken } from "../../middleware/auth";
import { apiLimiter } from "../../middleware/rateLimiter";

import scanRouter from "./scan";
import artistsRouter from "./artists";
import albumsRouter from "./albums";
import tracksRouter from "./tracks";
import streamingRouter from "./streaming";
import coverArtRouter from "./coverArt";
import backfillRouter from "./backfill";

const router = Router();

// All routes require auth (session or API key)
router.use(requireAuthOrToken);

// Apply API rate limiter to routes that need it
// Skip rate limiting for high-traffic endpoints (cover-art, streaming)
router.use((req, res, next) => {
  if (req.path.startsWith("/cover-art")) {
    return next();
  }
  if (req.path.includes("/stream")) {
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

export default router;
