import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import bcrypt from "bcrypt";
import { z } from "zod";
import axios from "axios";
import crypto from "crypto";
import { encryptField } from "../utils/systemSettings";
import { writeEnvFile } from "../utils/envWriter";
import { generateToken, requireAuth } from "../middleware/auth";

const router = Router();

// Validation schemas
const registerSchema = z.object({
    username: z.string().min(3).max(50),
    password: z.string().min(6),
});

const lidarrConfigSchema = z.object({
    url: z.string().url().optional().or(z.literal("")),
    apiKey: z.string().optional().or(z.literal("")),
    enabled: z.boolean(),
});

const audiobookshelfConfigSchema = z.object({
    url: z.string().url().optional().or(z.literal("")),
    apiKey: z.string().optional().or(z.literal("")),
    enabled: z.boolean(),
});

const soulseekConfigSchema = z.object({
    username: z.string().optional().or(z.literal("")),
    password: z.string().optional().or(z.literal("")),
    enabled: z.boolean(),
});

const enrichmentConfigSchema = z.object({
    enabled: z.boolean(),
});

/**
 * Generate a secure encryption key for settings encryption
 * This is called automatically during first user registration
 */
async function ensureEncryptionKey(): Promise<void> {
    // Check if encryption key already exists
    if (
        process.env.SETTINGS_ENCRYPTION_KEY &&
        process.env.SETTINGS_ENCRYPTION_KEY !==
            "default-encryption-key-change-me"
    ) {
        logger.debug("[ONBOARDING] Encryption key already exists");
        return;
    }

    // Generate a secure 32-byte encryption key
    const encryptionKey = crypto.randomBytes(32).toString("base64");

    logger.debug(
        "[ONBOARDING] Generating encryption key for settings security..."
    );

    try {
        // Write to .env file
        await writeEnvFile({
            SETTINGS_ENCRYPTION_KEY: encryptionKey,
        });

        // Update the process environment so it's available immediately
        process.env.SETTINGS_ENCRYPTION_KEY = encryptionKey;

        logger.debug("[ONBOARDING] Encryption key generated and saved to .env");
    } catch (error) {
        logger.error("[ONBOARDING] Failed to save encryption key:", error);
        throw new Error("Failed to generate encryption key");
    }
}

/**
 * POST /onboarding/register
 * Step 1: Create user account - returns JWT token like regular login
 */
router.post("/register", async (req, res) => {
    try {
        logger.debug("[ONBOARDING] Register attempt for user:", req.body?.username);
        const { username, password } = registerSchema.parse(req.body);

        // Check if any user exists (first user becomes admin)
        const userCount = await prisma.user.count();
        const isFirstUser = userCount === 0;

        // If this is the first user, ensure encryption key is generated
        if (isFirstUser) {
            await ensureEncryptionKey();
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

        // Create default user settings with optimal defaults
        await prisma.userSettings.create({
            data: {
                userId: user.id,
                playbackQuality: "original",
                wifiOnly: false,
                offlineEnabled: false,
                maxCacheSizeMb: 10240, // 10GB
            },
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
            logger.error("[ONBOARDING] Validation error:", err.errors);
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.errors });
        }
        logger.error("Registration error:", err);
        res.status(500).json({ error: "Failed to create account" });
    }
});

/**
 * POST /onboarding/lidarr
 * Step 2a: Configure Lidarr integration
 */
router.post("/lidarr", requireAuth, async (req, res) => {
    try {
        const config = lidarrConfigSchema.parse(req.body);

        // If not enabled, just save as disabled
        if (!config.enabled) {
            const settings = await prisma.systemSettings.findFirst();
            if (settings) {
                await prisma.systemSettings.update({
                    where: { id: settings.id },
                    data: { lidarrEnabled: false },
                });
            }
            return res.json({ success: true, tested: false });
        }

        // Test connection if enabled (non-blocking - save anyway)
        let connectionTested = false;
        if (config.url && config.apiKey) {
            try {
                const response = await axios.get(
                    `${config.url}/api/v1/system/status`,
                    {
                        headers: { "X-Api-Key": config.apiKey },
                        timeout: 5000,
                    }
                );

                if (response.status === 200) {
                    connectionTested = true;
                    logger.debug("Lidarr connection test successful");
                }
            } catch (error: any) {
                logger.warn(
                    "  Lidarr connection test failed (saved anyway):",
                    error.message
                );
                // Don't block - just log the warning
            }
        }

        // Save to system settings (even if connection test failed)
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: {
                id: "default",
                lidarrEnabled: config.enabled,
                lidarrUrl: config.url || null,
                lidarrApiKey: encryptField(config.apiKey),
            },
            update: {
                lidarrEnabled: config.enabled,
                lidarrUrl: config.url || null,
                lidarrApiKey: encryptField(config.apiKey),
            },
        });

        res.json({
            success: true,
            tested: connectionTested,
            warning: connectionTested
                ? null
                : "Connection test failed but settings saved. You can test again in Settings.",
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.errors });
        }
        logger.error("Lidarr config error:", err);
        res.status(500).json({ error: "Failed to save configuration" });
    }
});

/**
 * POST /onboarding/audiobookshelf
 * Step 2b: Configure Audiobookshelf integration
 */
router.post("/audiobookshelf", requireAuth, async (req, res) => {
    try {
        const config = audiobookshelfConfigSchema.parse(req.body);

        // If not enabled, just save as disabled
        if (!config.enabled) {
            const settings = await prisma.systemSettings.findFirst();
            if (settings) {
                await prisma.systemSettings.update({
                    where: { id: settings.id },
                    data: { audiobookshelfEnabled: false },
                });
            }
            return res.json({ success: true, tested: false });
        }

        // Test connection if enabled (non-blocking - save anyway)
        let connectionTested = false;
        if (config.url && config.apiKey) {
            try {
                const response = await axios.get(`${config.url}/api/me`, {
                    headers: { Authorization: `Bearer ${config.apiKey}` },
                    timeout: 5000,
                });

                if (response.status === 200) {
                    connectionTested = true;
                    logger.debug("Audiobookshelf connection test successful");
                }
            } catch (error: any) {
                logger.warn(
                    "  Audiobookshelf connection test failed (saved anyway):",
                    error.message
                );
                // Don't block - just log the warning
            }
        }

        // Save to system settings (even if connection test failed)
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: {
                id: "default",
                audiobookshelfEnabled: config.enabled,
                audiobookshelfUrl: config.url || null,
                audiobookshelfApiKey: encryptField(config.apiKey),
            },
            update: {
                audiobookshelfEnabled: config.enabled,
                audiobookshelfUrl: config.url || null,
                audiobookshelfApiKey: encryptField(config.apiKey),
            },
        });

        res.json({
            success: true,
            tested: connectionTested,
            warning: connectionTested
                ? null
                : "Connection test failed but settings saved. You can test again in Settings.",
        });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.errors });
        }
        logger.error("Audiobookshelf config error:", err);
        res.status(500).json({ error: "Failed to save configuration" });
    }
});

/**
 * POST /onboarding/soulseek
 * Step 2c: Configure Soulseek integration (direct connection via slsk-client)
 */
router.post("/soulseek", requireAuth, async (req, res) => {
    try {
        const config = soulseekConfigSchema.parse(req.body);

        // If not enabled, clear credentials
        if (!config.enabled) {
            await prisma.systemSettings.upsert({
                where: { id: "default" },
                create: {
                    id: "default",
                    soulseekUsername: null,
                    soulseekPassword: null,
                },
                update: {
                    soulseekUsername: null,
                    soulseekPassword: null,
                },
            });
            return res.json({ success: true, tested: false });
        }

        // If enabled, require credentials
        if (!config.username || !config.password) {
            return res.status(400).json({
                error: "Soulseek username and password are required",
            });
        }

        // Save to system settings
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

        res.json({ success: true, tested: true });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.errors });
        }
        logger.error("Soulseek config error:", err);
        res.status(500).json({ error: "Failed to save configuration" });
    }
});

/**
 * POST /onboarding/enrichment
 * Step 3: Configure metadata enrichment
 */
router.post("/enrichment", requireAuth, async (req, res) => {
    try {
        const config = enrichmentConfigSchema.parse(req.body);

        // Update user settings
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                enrichmentSettings: {
                    enabled: config.enabled,
                    lastRun: null,
                },
            },
        });

        res.json({ success: true });
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.errors });
        }
        logger.error("Enrichment config error:", err);
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
        // Check if any users exist in the system
        const userCount = await prisma.user.count();
        const hasAccount = userCount > 0;

        // Check for JWT token in Authorization header
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith("Bearer ")
            ? authHeader.substring(7)
            : null;

        // If no token, return whether any users exist
        if (!token) {
            return res.json({
                needsOnboarding: !hasAccount,
                hasAccount,
            });
        }

        // Try to verify token and check onboarding status
        try {
            const jwt = require("jsonwebtoken");
            const JWT_SECRET =
                process.env.JWT_SECRET ||
                "your-secret-key-change-in-production";
            const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: { onboardingComplete: true },
            });

            res.json({
                needsOnboarding: !user?.onboardingComplete,
                hasAccount: true,
            });
        } catch {
            // Invalid token - return basic status
            res.json({
                needsOnboarding: !hasAccount,
                hasAccount,
            });
        }
    } catch (err: any) {
        logger.error("Onboarding status error:", err);
        res.status(500).json({ error: "Failed to check status" });
    }
});

export default router;
