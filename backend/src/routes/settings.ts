import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { staleJobCleanupService } from "../services/staleJobCleanup";
import { defaultUserSettingsFor } from "../utils/userSettingsDefaults";
import { encryptField } from "../utils/encryption";
import { config } from "../config";
import { publicUserId, setLiveHidden } from "../services/liveListening";

const router = Router();

router.use(requireAuth);

const settingsSchema = z.object({
    playbackQuality: z.enum(["original", "high", "medium", "low"]).optional(),
    wifiOnly: z.boolean().optional(),
    offlineEnabled: z.boolean().optional(),
    maxCacheSizeMb: z.number().int().min(0).optional(),
    // Write-only scrobble credential: accepted on save (null clears),
    // never echoed back on GET.
    listenbrainzToken: z.string().min(1).nullable().optional(),
    shareLiveListening: z.boolean().optional(),
});

/** Whether this user is the one whose listening KIMA_PUBLIC_VIBE shares. */
async function isPublicListener(userId: string): Promise<boolean> {
    return Boolean(config.publicVibe) && userId === (await publicUserId());
}

/** Strip write-only secrets from a row before it goes to the client. */
function publicSettings(
    settings: { listenbrainzToken?: string | null; [k: string]: unknown },
    liveSharingAvailable: boolean
) {
    const { listenbrainzToken, ...rest } = settings;
    return { ...rest, hasListenbrainzToken: Boolean(listenbrainzToken), liveSharingAvailable };
}

// GET /settings
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;

        let settings = await prisma.userSettings.findUnique({
            where: { userId },
        });

        // Create default settings if they don't exist
        if (!settings) {
            settings = await prisma.userSettings.create({
                data: defaultUserSettingsFor(userId),
            });
        }

        res.json(publicSettings(settings, await isPublicListener(userId)));
    } catch (error) {
        logger.error("Get settings error:", error);
        res.status(500).json({ error: "Failed to get settings" });
    }
});

// POST /settings
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const data = settingsSchema.parse(req.body);

        const { listenbrainzToken, ...rest } = data;
        const payload = {
            ...rest,
            ...(listenbrainzToken !== undefined
                ? { listenbrainzToken: encryptField(listenbrainzToken) }
                : {}),
        };
        const settings = await prisma.userSettings.upsert({
            where: { userId },
            create: {
                userId,
                ...payload,
            },
            update: payload,
        });

        const publicListener = await isPublicListener(userId);
        if (publicListener && data.shareLiveListening !== undefined) {
            setLiveHidden(!data.shareLiveListening);
        }
        res.json(publicSettings(settings, publicListener));
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid settings", details: error.errors });
        }
        logger.error("Update settings error:", error);
        res.status(500).json({ error: "Failed to update settings" });
    }
});

// POST /settings/cleanup-stale-jobs
router.post("/cleanup-stale-jobs", requireAdmin, async (_req, res) => {
    try {
        const result = await staleJobCleanupService.cleanupAll();

        res.json({
            success: true,
            cleaned: {
                discoveryBatches: result.discoveryBatches,
                downloadJobs: result.downloadJobs,
                spotifyImportJobs: result.spotifyImportJobs,
                bullQueues: result.bullQueues,
            },
            totalCleaned: result.totalCleaned,
        });
    } catch (error) {
        logger.error("Stale job cleanup error:", error);
        res.status(500).json({ error: "Failed to cleanup stale jobs" });
    }
});

export default router;
