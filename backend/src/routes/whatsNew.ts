/**
 * The release window's endpoints, at /api/whats-new (/api/releases is the
 * Release Radar). The server decides what is pending; a client cannot claim a
 * release was seen, since that would suppress a consent prompt.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import {
    UnknownChoiceError,
    dismissRelease,
    findRelease,
    GPU_CHOICE_KEY,
    pendingReleases,
    currentReleaseFor,
    changelogFor,
    openRequirements,
    setChoice,
} from "../services/releases";
import { setGpuToggles, gpuSupported } from "../services/gpuRuntime";
import {
    MoodMixCannotKeepError,
    MoodMixNotFoundError,
    decideMoodMixes,
    moodMixState,
    saveMoodMixAsPlaylist,
} from "../services/releases/moodMixes";

const router = Router();
router.use(requireAuth);

/** GET /whats-new/pending — the newest release, until this user closes it; older ones live on the changelog. */
router.get("/pending", async (req, res) => {
    try {
        res.json({ releases: await pendingReleases(req.user!.id) });
    } catch (error) {
        logger.error("[WhatsNew] pending failed:", error);
        res.status(500).json({ error: "Failed to load releases" });
    }
});

/** GET /whats-new/update-status — whether a newer server release exists. */
router.get("/update-status", async (_req, res) => {
    try {
        const { getUpdateStatus } = await import("../services/updateCheck");
        res.json(await getUpdateStatus());
    } catch (error) {
        logger.error("[WhatsNew] update status failed:", error);
        res.status(500).json({ error: "Failed to check for updates" });
    }
});

/** GET /whats-new/current — the newest release with what this user already settled, to read again after closing it. */
router.get("/current", async (req, res) => {
    try {
        const current = await currentReleaseFor(req.user!.id);
        if (!current) return res.status(404).json({ error: "No release" });
        res.json(current);
    } catch (error) {
        logger.error("[WhatsNew] current failed:", error);
        res.status(500).json({ error: "Failed to load release" });
    }
});

/** GET /whats-new/changelog — every release, newest first (see changelogFor). */
router.get("/changelog", async (req, res) => {
    try {
        res.json(await changelogFor(req.user!.id));
    } catch (error) {
        logger.error("[WhatsNew] changelog failed:", error);
        res.status(500).json({ error: "Failed to load the changelog" });
    }
});

/** GET /whats-new/open — what this user was told to do and the server cannot yet see done. */
router.get("/open", async (req, res) => {
    try {
        res.json(await openRequirements(req.user!.id));
    } catch (error) {
        logger.error("[WhatsNew] open requirements failed:", error);
        res.status(500).json({ error: "Failed to load open requirements" });
    }
});

// The 1.11 mood-mix question (services/releases/moodMixes.ts).

/** GET /whats-new/mood-mixes — the user's saved mix, and what they decided. */
router.get("/mood-mixes", async (req, res) => {
    try {
        res.json(await moodMixState(req.user!.id));
    } catch (error) {
        logger.error("[WhatsNew] mood-mix state failed:", error);
        res.status(500).json({ error: "Failed to load your mood mix" });
    }
});

const moodMixDecisionSchema = z.object({ decision: z.enum(["rebuild", "keep", "remove"]) });

/**
 * POST /whats-new/mood-mixes/decision — rebuild or remove (both clear the saved
 * mix), or keep. Keep is refused for a mix under a removed mood.
 */
router.post("/mood-mixes/decision", async (req, res) => {
    try {
        const { decision } = moodMixDecisionSchema.parse(req.body);
        res.json(await decideMoodMixes(req.user!.id, decision));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.issues });
        }
        if (error instanceof MoodMixCannotKeepError) {
            return res.status(400).json({
                error: "This mood mix can't be shown any more. Save it as a playlist or remove it.",
            });
        }
        logger.error("[WhatsNew] mood-mix decision failed:", error);
        res.status(500).json({ error: "Failed to record your choice" });
    }
});

const moodMixSaveSchema = z.object({ mixId: z.string().min(1) });

/** POST /whats-new/mood-mixes/save — copy the saved mix into a playlist. */
router.post("/mood-mixes/save", async (req, res) => {
    try {
        const { mixId } = moodMixSaveSchema.parse(req.body);
        res.json(await saveMoodMixAsPlaylist(req.user!.id, mixId));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.issues });
        }
        if (error instanceof MoodMixNotFoundError) {
            return res.status(404).json({ error: "Mood mix not found" });
        }
        logger.error("[WhatsNew] mood-mix save failed:", error);
        res.status(500).json({ error: "Failed to save your mood mix" });
    }
});

const choiceSchema = z.object({ key: z.string().min(1), enabled: z.boolean() });

/** POST /whats-new/:version/choice — record an explicit answer. */
router.post("/:version/choice", async (req, res) => {
    try {
        const { version } = req.params;
        if (!findRelease(version)) return res.status(404).json({ error: "Unknown release" });

        const { key, enabled } = choiceSchema.parse(req.body);
        // The GPU choice changes a system setting, so only an admin may apply it,
        // through the Settings toggle's service. Apply before recording, so a failed
        // apply leaves nothing on record and the client can retry.
        if (key === GPU_CHOICE_KEY) {
            if (req.user!.role !== "admin") {
                return res.status(403).json({ error: "Only admins can change GPU acceleration" });
            }
            if (enabled && !gpuSupported()) {
                return res.status(400).json({ error: "GPU acceleration is only available on linux/x86_64 hosts" });
            }
            await setGpuToggles({ soundVectors: enabled });
        }
        await setChoice({ userId: req.user!.id, version, key, enabled });
        res.json({ key, enabled, decidedBy: "EXPLICIT" });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid request", details: error.issues });
        }
        if (error instanceof UnknownChoiceError) {
            return res.status(400).json({ error: "Unknown choice" });
        }
        logger.error("[WhatsNew] choice failed:", error);
        res.status(500).json({ error: "Failed to record choice" });
    }
});

/**
 * POST /whats-new/:version/dismiss — close it.
 *
 * Anything unanswered is settled here at its default. The response names the
 * keys that covered, so the client can show what was just decided on the user's
 * behalf rather than hiding it.
 */
router.post("/:version/dismiss", async (req, res) => {
    try {
        const { version } = req.params;
        if (!findRelease(version)) return res.status(404).json({ error: "Unknown release" });

        const { recordedDefaults } = await dismissRelease(req.user!.id, version);
        res.json({ version, dismissed: true, recordedDefaults });
    } catch (error) {
        logger.error("[WhatsNew] dismiss failed:", error);
        res.status(500).json({ error: "Failed to dismiss release" });
    }
});

export default router;
