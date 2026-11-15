/**
 * One request for the whole Stats page; the gathers run concurrently. The
 * server section is omitted, not zeroed, for non-admins. Actions (clearing
 * caches and jobs, retrying failures) use their own endpoints.
 */

import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../utils/logger";
import { invalidRequest } from "../utils/errors";
import { hourDetail, listeningStats, regionDetail, trackPlayCount } from "../services/stats/listening";
import { shelfStats } from "../services/stats/shelf";
import { signature } from "../services/stats/signature";
import { playableSlice, type Slice } from "../services/stats/playable";
import { asPeriod, withListens } from "../services/stats/listens";
import { spokenStats } from "../services/stats/spoken";
import { systemStats } from "../services/stats/system";
import {
    auditFalseStarts,
    collapseDuplicateRows,
    ignoreTracks,
    removeFalseStarts,
    unignoreTracks,
} from "../services/playHistoryRepair";

const router = Router();
/**
 * GET /stats?tz=Europe/London
 *
 * The timezone is the client's own IANA zone. Without it the hour-of-day grid
 * would be drawn in UTC, which tells a person nothing about their own evenings.
 */
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const isAdmin = req.user!.role === "admin";
        const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
        const period = asPeriod(req.query.period);

        // Shelf, spoken and system are all-time: they are not made of plays, and a
        // window would give true but useless numbers. The page labels them so.
        // The two sections made of plays read one fold of them: the page folds once.
        const [[listening, sig], shelf, spoken, system] = await Promise.all([
            withListens(userId, period, async (listens) =>
                Promise.all([listeningStats(listens, tz), signature(listens, tz ?? "UTC")]),
            ),
            shelfStats(userId),
            spokenStats(userId),
            isAdmin ? systemStats(config.version) : Promise.resolve(undefined),
        ]);

        res.json({ period, listening, shelf, spoken, signature: sig, ...(system ? { system } : {}) });
    } catch (error) {
        logger.error("[Stats] failed to gather:", error);
        res.status(500).json({ error: "Failed to load stats" });
    }
});

/**
 * GET /stats/hour?dow=4&hour=19&tz=... — what was playing in one cell of the week.
 *
 * Separate from the page's own read because most visits never ask it, and 168
 * cells of track lists is a payload nobody would look at.
 */
router.get("/hour", async (req, res) => {
    try {
        const dow = Number(req.query.dow);
        const hour = Number(req.query.hour);
        if (!Number.isInteger(dow) || dow < 0 || dow > 6 ||
            !Number.isInteger(hour) || hour < 0 || hour > 23) {
            return res.status(400).json({ error: "Bad request" });
        }
        const tz = typeof req.query.tz === "string" ? req.query.tz : undefined;
        res.json(await hourDetail(req.user!.id, dow, hour, tz, asPeriod(req.query.period)));
    } catch (error) {
        logger.error("[Stats] hour detail failed:", error);
        res.status(500).json({ error: "Failed to read that hour" });
    }
});

/**
 * GET /stats/tracks?of=never — a slice of the page, as something you can play.
 *
 * Every value of `of` corresponds to a figure the page already states, so this
 * never answers a question the reader has not been shown.
 */
const SLICES = new Set<Slice>(["top", "never", "core", "key", "decade"]);

router.get("/tracks", async (req, res) => {
    try {
        const of = String(req.query.of ?? "") as Slice;
        if (!SLICES.has(of)) return res.status(400).json({ error: "Bad request" });
        const tracks = await playableSlice({
            userId: req.user!.id,
            slice: of,
            key: typeof req.query.key === "string" ? req.query.key : undefined,
            decade: req.query.decade ? Number(req.query.decade) : undefined,
            // NaN is not nullish, so it must be dropped here rather than defaulted later.
            limit: Number.isFinite(Number(req.query.limit))
                ? Number(req.query.limit)
                : undefined,
            period: asPeriod(req.query.period),
        });
        res.json({ tracks });
    } catch (error) {
        logger.error("[Stats] playable slice failed:", error);
        res.status(500).json({ error: "Couldn't gather those tracks" });
    }
});

/**
 * GET /stats/track/:id/plays — how many times this person has heard one track.
 *
 * For the line in the player bar. Deliberately its own tiny read rather than a
 * field on the track payload: it changes as you listen, the track payload is
 * cached, and a stale count printed next to a playing song is worse than none.
 */
router.get("/track/:id/plays", async (req, res) => {
    try {
        const id = String(req.params.id ?? "");
        if (!id || id.length > 64) return res.status(400).json({ error: "Bad request" });
        res.json({ plays: await trackPlayCount(req.user!.id, id) });
    } catch (error) {
        logger.error("[Stats] track play count failed:", error);
        res.status(500).json({ error: "Couldn't count that track" });
    }
});

/** GET /stats/region?x=12&y=18 — what sits at one point of the taste plot. */
router.get("/region", async (req, res) => {
    try {
        const x = Number(req.query.x);
        const y = Number(req.query.y);
        if (!Number.isInteger(x) || x < 1 || x > 24 || !Number.isInteger(y) || y < 1 || y > 24) {
            return res.status(400).json({ error: "Bad request" });
        }
        res.json(await regionDetail(req.user!.id, x, y, undefined, asPeriod(req.query.period)));
    } catch (error) {
        logger.error("[Stats] region detail failed:", error);
        res.status(500).json({ error: "Failed to read that region" });
    }
});

/* ── The play-history audit ──────────────────────────────────────────────────
 * A permanent maintenance tool beside the stats it corrects. Reading is
 * separate from acting; acting takes track ids only.
 * ─────────────────────────────────────────────────────────────────────────── */

/** At most this many tracks may be named in one action. */
const MAX_TRACKS_PER_ACTION = 2000;

const trackListSchema = z.object({
    trackIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_TRACKS_PER_ACTION),
});

/** GET /stats/false-starts — what the audit can prove, grouped by track. */
router.get("/false-starts", async (req, res) => {
    try {
        res.json(await auditFalseStarts(req.user!.id));
    } catch (error) {
        logger.error("[Stats] false-start audit failed:", error);
        res.status(500).json({ error: "Failed to read your play history" });
    }
});

/**
 * POST /stats/false-starts/collapse — merge duplicate records into one row each.
 * No track list: a row written while the track was still playing is a listen
 * already counted, so this half needs no judgement.
 */
router.post("/false-starts/collapse", async (req, res) => {
    try {
        res.json(await collapseDuplicateRows(req.user!.id));
    } catch (error) {
        logger.error("[Stats] collapse failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

/** POST /stats/false-starts/remove — delete the provable ones on these tracks. */
router.post("/false-starts/remove", async (req, res) => {
    try {
        const { trackIds } = trackListSchema.parse(req.body);
        res.json(await removeFalseStarts(req.user!.id, trackIds));
    } catch (error) {
        if (error instanceof z.ZodError) return invalidRequest(req, res, error);
        logger.error("[Stats] false-start removal failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

/** POST /stats/false-starts/ignore — stop raising these. Deletes nothing. */
router.post("/false-starts/ignore", async (req, res) => {
    try {
        const { trackIds } = trackListSchema.parse(req.body);
        res.json(await ignoreTracks(req.user!.id, trackIds));
    } catch (error) {
        if (error instanceof z.ZodError) return invalidRequest(req, res, error);
        logger.error("[Stats] ignore failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

/** POST /stats/false-starts/restore — put ignored tracks back in the audit. */
router.post("/false-starts/restore", async (req, res) => {
    try {
        const { trackIds } = trackListSchema.parse(req.body);
        res.json(await unignoreTracks(req.user!.id, trackIds));
    } catch (error) {
        if (error instanceof z.ZodError) return invalidRequest(req, res, error);
        logger.error("[Stats] restore failed:", error);
        res.status(500).json({ error: "That didn't finish" });
    }
});

export default router;
