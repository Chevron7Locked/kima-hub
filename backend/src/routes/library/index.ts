import { Router } from "express";

import scanRouter from "./scan";
import artistsRouter from "./artists";
import albumsRouter from "./albums";
import tracksRouter from "./tracks";
import streamingRouter from "./streaming";
import coverArtRouter from "./coverArt";
import backfillRouter from "./backfill";
import waveformRouter from "./waveform";

const router = Router();

// The mount carries the runaway limit (routes/mountAccess); cover art and the album cover search carry the image limit.

router.use(scanRouter);
router.use(artistsRouter);
router.use(albumsRouter);
router.use(tracksRouter);
router.use(streamingRouter);
router.use(coverArtRouter);
router.use(backfillRouter);
router.use(waveformRouter);

export default router;
