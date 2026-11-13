import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { z } from "zod";
import axios from "axios";
import { getSystemSettings, saveSystemSettings, type SystemSettingsChanges, type SystemSettingsField } from "../utils/systemSettings";
import { generateRefreshToken, generateToken, requireAuth, requireAdmin, signedInUser } from "../middleware/auth";
import { signUp } from "../services/users/accounts";
import { createLidarrClient } from "../services/lidarrClient";

const router = Router();

const registerSchema = z.object({
    username: z.string().min(3).max(50),
    password: z.string(),
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

type ServiceFields = { enabled: SystemSettingsField; url: SystemSettingsField; apiKey: SystemSettingsField };

/**
 * A setup step that saves one service's address and key, admin only. A failed connection test still saves, with a
 * warning; turning the service off saves that alone.
 */
function serviceStep(name: string, fields: ServiceFields, connects: (url: string, apiKey: string) => Promise<boolean>) {
    return async (req: Request, res: Response) => {
        try {
            const config = serviceConfigSchema.parse(req.body);
            const data: SystemSettingsChanges = config.enabled
                ? {
                      [fields.enabled]: true,
                      [fields.url]: config.url || null,
                      [fields.apiKey]: config.apiKey ?? null,
                  }
                : { [fields.enabled]: false };
            const tested = config.enabled && !!config.url && !!config.apiKey
                ? await connects(config.url!, config.apiKey!).catch((error) => {
                      logger.warn(`[ONBOARDING] ${name} connection test failed (saved anyway): ${error.message}`);
                      return false;
                  })
                : false;

            await saveSystemSettings(data);

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
 * Step 1: Create user account - returns a JWT and a refresh token, like regular login
 */
router.post("/register", async (req, res) => {
    try {
        logger.debug(
            "[ONBOARDING] Register attempt for user:",
            req.body?.username
        );
        const { username, password } = registerSchema.parse(req.body);

        const made = await signUp({ username, password, registrationOpen: await registrationOpen() });
        if (!made.ok) {
            if (made.reason === "registration-closed") return res.status(403).json({ error: "Registration is closed" });
            if (made.reason === "username-taken") {
                logger.debug("[ONBOARDING] Username already taken:", username);
                return res.status(400).json({ error: "Username already taken" });
            }
            return res.status(400).json({ error: `Password must be at least ${made.minimum} characters` });
        }
        const user = made.user;

        // Sign the new account in as login does: a JWT and, below, a refresh token
        const token = generateToken({
            id: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
        });

        logger.debug("[ONBOARDING] User created successfully:", user.username);
        res.json({
            token,
            refreshToken: generateRefreshToken({ id: user.id, tokenVersion: user.tokenVersion }),
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
            await saveSystemSettings({ soulseekUsername: null, soulseekPassword: null });
            return res.json({ success: true, tested: false });
        }

        if (!config.username || !config.password) {
            return res.status(400).json({
                error: "Soulseek username and password are required",
            });
        }

        const changed = await saveSystemSettings({ soulseekUsername: config.username, soulseekPassword: config.password });

        // Being connected with the saved account is the connection test. A changed account was already reconnected by
        // the save; an unchanged one is tried again here.
        let connectionTested = false;
        try {
            const { soulseekService } = await import("../services/soulseek");
            if (changed.length === 0) await soulseekService.resetAndReconnect();
            if (!soulseekService.isConnected()) throw new Error("not connected");
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

        // Fire-and-forget audiobook sync if Audiobookshelf was enabled
        (async () => {
            try {
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
