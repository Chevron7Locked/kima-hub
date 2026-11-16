import express from "express";
import { logger } from "../utils/logger";
import { refuseRequest } from "../utils/errors";
import { LiveQueueEntry, isPublicListener, reportLive } from "../services/liveListening";
import { clearPlaybackState, queueLimit, readPlaybackState, readWebSave, saveWebState } from "../services/savedQueue";

const router = express.Router();

/** The limit, for the client, so it does not have to guess. */
router.get("/limit", async (_req, res) => {
    res.json({ maxQueueLength: await queueLimit() });
});

// Get current playback state for the authenticated user
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        res.json(await readPlaybackState(userId));
    } catch (error) {
        logger.error("Get playback state error:", error);
        res.status(500).json({ error: "Failed to get playback state" });
    }
});

// Update current playback state for the authenticated user
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const read = readWebSave(req.body);
        if ("refused" in read) return refuseRequest(req, res, read.refused.reason, read.refused.answer);

        const answer = await saveWebState(userId, read.save);
        if ("changed" in answer) return res.status(409).json(answer.changed);
        res.json(answer.saved);
    } catch (error) {
        logger.error("Save playback state error:", error);
        res.status(500).json({ error: "Failed to save playback state" });
    }
});

const LIVE_STATUSES = new Set(["playing", "paused", "stopped"]);

function millis(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// The web player's play/pause/seek/track changes, for the public live trip. Players only send
// them when /system/features says so; anyone else still gets a 404, which silences them.
router.post("/live", async (req, res) => {
    try {
        if (!(await isPublicListener(req.user!.id))) {
            return res.status(404).json({ error: "Not available" });
        }
        const { status, trackId, position, duration, queue } = req.body ?? {};
        const positionMs = millis(position);
        const durationMs = millis(duration);
        if (!LIVE_STATUSES.has(status) || typeof trackId !== "string" || !trackId || positionMs === null || durationMs === null) {
            return res.status(400).json({ error: "status, trackId, position and duration are required" });
        }
        const upNext: LiveQueueEntry[] = Array.isArray(queue)
            ? queue
                .filter((e: any) => e && typeof e.trackId === "string" && millis(e.duration) !== null)
                .map((e: any) => ({ trackId: e.trackId, duration: millis(e.duration)! }))
            : [];
        reportLive({ status, trackId, position: positionMs, duration: durationMs, queue: upNext });
        res.json({ ok: true });
    } catch (error) {
        // Not a 404: that would silence the player for the session over one failed lookup.
        logger.error("Live playback report error:", error);
        res.status(500).json({ error: "Failed to report live playback" });
    }
});

// Clear playback state (when user stops playback completely)
router.delete("/", async (req, res) => {
    try {
        const cleared = await clearPlaybackState(req.user!.id, req.query.expectedUpdatedAt);
        if ("refused" in cleared) return refuseRequest(req, res, cleared.refused.reason, cleared.refused.answer);
        if ("changed" in cleared) return res.status(409).json(cleared.changed);
        res.json({ success: true, cleared: cleared.cleared });
    } catch (error) {
        logger.error("Delete playback state error:", error);
        res.status(500).json({ error: "Failed to delete playback state" });
    }
});

export default router;
