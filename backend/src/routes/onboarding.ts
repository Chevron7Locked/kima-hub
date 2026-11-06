import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import bcrypt from "bcrypt";
import { z } from "zod";
import axios from "axios";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";
import { encryptField } from "../utils/encryption";
import { encryptSettings } from "../utils/encryptedFields";
import { generateToken, requireAuth, requireAdmin, signedInUser } from "../middleware/auth";
import { defaultUserSettingsFor } from "../utils/userSettingsDefaults";
import { createLidarrClient } from "../services/lidarrClient";

const router = Router();

const registerSchema = z.object({
    username: z.string().min(3).max(50),
    password: z.string().min(6),
});

const serviceConfigSchema = z.object({
    url: z.string().optional(),
    apiKey: z.string().optional(),
    enabled: z.boolean(),
}).refine(
    (data) => !data.enabled || !data.url || z.string().url().safeParse(data.url).success,
    { message: "Invalid url", path: ["url"] },
);

const soulseekConfigSchema = z.object({
    username: z.string().optional(),
    password: z.string().optional(),
    enabled: z.boolean(),
});

/** Whether someone may create an account now that the first one exists. */
async function registrationOpen(): Promise<boolean> {
    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
        select: { registrationOpen: true },
    });
    return settings?.registrationOpen ?? false;
}

const settingsRow = () => prisma.systemSettings.findUnique({ where: { id: "default" } });

type ServiceFields = { enabled: string; url: string; apiKey: string };

/**
 * A setup step that saves one service's address and key, admin only. A failed connection test still saves, with a
 * warning; turning the service off saves that alone.
 */
function serviceStep(name: string, fields: ServiceFields, connects: (url: string, apiKey: string) => Promise<boolean>) {
    return async (req: Request, res: Response) => {
        try {
            const config = serviceConfigSchema.parse(req.body);
            const data = config.enabled
                ? encryptSettings(
                      {
                          [fields.enabled]: true,
                          [fields.url]: config.url || null,
                          [fields.apiKey]: config.apiKey ?? null,
                      },
                      await settingsRow(),
                  )
                : { [fields.enabled]: false };
            const tested = config.enabled && !!config.url && !!config.apiKey
                ? await connects(config.url!, config.apiKey!).catch((error) => {
                      logger.warn(`[ONBOARDING] ${name} connection test failed (saved anyway): ${error.message}`);
                      return false;
                  })
                : false;

            await prisma.systemSettings.upsert({
                where: { id: "default" },
                create: { id: "default", ...data },
                update: data,
            });
            invalidateSystemSettingsCache();

            if (!config.enabled) return res.json({ success: true, tested: false });
            res.json({
                success: true,
                tested,
                warning: tested ? null : SAVED_UNTESTED,
            });
        } catch (err: any) {
            if (err instanceof z.ZodError) {
                return res.status(400).json({ error: "Invalid request", details: err.issues });
            }
            logger.error(`${name} config error:`, err);
            res.status(500).json({ error: "Failed to save configuration" });
        }
    };
}

const SAVED_UNTESTED = "Connection test failed but settings saved. You can test again in Settings.";

/**
 * POST /onboarding/register
 * Step 1: Create user account - returns JWT token like regular login
 */
router.post("/register", async (req, res) => {
    try {
        logger.debug(
            "[ONBOARDING] Register attempt for user:",
            req.body?.username
        );
        const { username, password } = registerSchema.parse(req.body);

        // Check if any user exists (first user becomes admin)
        const userCount = await prisma.user.count();
        const isFirstUser = userCount === 0;

        if (!isFirstUser && !(await registrationOpen())) {
            return res.status(403).json({ error: "Registration is closed" });
        }

        // Check if username is taken
        const existing = await prisma.user.findUnique({
            where: { username },
        });

        if (existing) {
            logger.debug("[ONBOARDING] Username already taken:", username);
            return res.status(400).json({ error: "Username already taken" });
        }

        // Create user
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                username,
                passwordHash,
                role: isFirstUser ? "admin" : "user",
                onboardingComplete: false,
            },
        });

        // Create default user settings
        await prisma.userSettings.create({
            data: defaultUserSettingsFor(user.id),
        });

        // Generate JWT token (same as login)
        const token = generateToken({
            id: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
        });

        logger.debug("[ONBOARDING] User created successfully:", user.username);
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                onboardingComplete: false,
            },
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            logger.error("[ONBOARDING] Validation error:", err.issues);
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.issues });
        }
        logger.error("[ONBOARDING] Registration error:", { message: err.message, code: err.code, stack: err.stack });
        res.status(500).json({ error: "Failed to create account" });
    }
});

/** POST /onboarding/lidarr: step 2a, Lidarr. */
router.post(
    "/lidarr",
    requireAuth,
    requireAdmin,
    serviceStep("Lidarr", { enabled: "lidarrEnabled", url: "lidarrUrl", apiKey: "lidarrApiKey" }, async (url, apiKey) =>
        (await createLidarrClient(url, apiKey, 5000).get("/api/v1/system/status")).status === 200
    )
);

/** POST /onboarding/audiobookshelf: step 2b, Audiobookshelf. */
router.post(
    "/audiobookshelf",
    requireAuth,
    requireAdmin,
    serviceStep(
        "Audiobookshelf",
        { enabled: "audiobookshelfEnabled", url: "audiobookshelfUrl", apiKey: "audiobookshelfApiKey" },
        async (url, apiKey) =>
            (await axios.get(`${url}/api/me`, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000 })).status === 200
    )
);

/**
 * POST /onboarding/soulseek
 * Step 2c: Configure Soulseek integration (direct connection via soulseek-ts)
 */
router.post("/soulseek", requireAuth, requireAdmin, async (req, res) => {
    try {
        const config = soulseekConfigSchema.parse(req.body);

        if (!config.enabled) {
            const soulseekOff = encryptSettings({ soulseekUsername: null, soulseekPassword: null }, await settingsRow());
            await prisma.systemSettings.upsert({
                where: { id: "default" },
                create: { id: "default", ...soulseekOff },
                update: soulseekOff,
            });
            invalidateSystemSettingsCache();
            return res.json({ success: true, tested: false });
        }

        if (!config.username || !config.password) {
            return res.status(400).json({
                error: "Soulseek username and password are required",
            });
        }

        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: {
                id: "default",
                soulseekUsername: config.username,
                soulseekPassword: encryptField(config.password),
            },
            update: {
                soulseekUsername: config.username,
                soulseekPassword: encryptField(config.password),
            },
        });
        invalidateSystemSettingsCache();

        // Reconnecting with the saved account is the connection test.
        let connectionTested = false;
        try {
            const { soulseekService } = await import("../services/soulseek");
            await soulseekService.resetAndReconnect();
            connectionTested = true;
            logger.debug("[ONBOARDING] Soulseek connection test successful");
        } catch (error: any) {
            logger.warn(`[ONBOARDING] Soulseek connection test failed (saved anyway): ${error.message}`);
        }

        res.json({
            success: true,
            tested: connectionTested,
            warning: connectionTested ? null : SAVED_UNTESTED,
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.issues });
        }
        logger.error("Soulseek config error:", err);
        res.status(500).json({ error: "Failed to save configuration" });
    }
});

/**
 * POST /onboarding/complete
 * Final step: Mark onboarding as complete
 */
router.post("/complete", requireAuth, async (req, res) => {
    try {
        await prisma.user.update({
            where: { id: req.user!.id },
            data: { onboardingComplete: true },
        });

        logger.debug("[ONBOARDING] User completed onboarding:", req.user!.id);

        // Ensure services pick up credentials saved during onboarding
        invalidateSystemSettingsCache();

        try {
            const { lidarrService } = await import("../services/lidarr");
            lidarrService.reinitialize();
        } catch (err) {
            logger.warn("[ONBOARDING] Could not reinitialize Lidarr service:", err);
        }

        try {
            const { audiobookshelfService } = await import("../services/audiobookshelf");
            audiobookshelfService.reinitialize();
        } catch (err) {
            logger.warn("[ONBOARDING] Could not reinitialize Audiobookshelf service:", err);
        }

        // Fire-and-forget audiobook sync if Audiobookshelf was enabled
        (async () => {
            try {
                const { getSystemSettings } = await import("../utils/systemSettings");
                const settings = await getSystemSettings();
                if (settings?.audiobookshelfEnabled) {
                    const { audiobookCacheService } = await import("../services/audiobookCache");
                    const result = await audiobookCacheService.syncAll();
                    logger.info(`[ONBOARDING] Audiobook sync complete: ${result.synced} synced`);
                }
            } catch (err) {
                logger.warn("[ONBOARDING] Post-onboarding audiobook sync failed:", err);
            }
        })();

        res.json({ success: true });
    } catch (err: any) {
        logger.error("Onboarding complete error:", err);
        res.status(500).json({ error: "Failed to complete onboarding" });
    }
});

/**
 * GET /onboarding/status
 * Check if user needs onboarding
 */
router.get("/status", async (req, res) => {
    try {
        const userCount = await prisma.user.count();
        const hasAccount = userCount > 0;

        // Open for the first account; then the admin's setting.
        const open = hasAccount ? await registrationOpen() : true;
        const basic = { needsOnboarding: !hasAccount, hasAccount, registrationOpen: open };

        // A token counts only as far as sign-in trusts it (not a refresh token, stream ticket or revoked token).
        const user = await signedInUser(req);
        if (!user) return res.json(basic);

        const account = await prisma.user.findUnique({
            where: { id: user.id },
            select: { onboardingComplete: true },
        });
        res.json(account ? { ...basic, needsOnboarding: !account.onboardingComplete } : basic);
    } catch (err: any) {
        logger.error("Onboarding status error:", err);
        res.status(500).json({ error: "Failed to check status" });
    }
});

export default router;
