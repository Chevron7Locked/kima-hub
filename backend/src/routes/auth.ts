import { Router } from "express";
import { logger } from "../utils/logger";
import bcrypt from "bcrypt";
import { prisma } from "../utils/db";
import { defaultUserSettingsFor } from "../utils/userSettingsDefaults";
import { z } from "zod";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { NO_ACCOUNT_PASSWORD_HASH, totpMatches } from "../services/users/credentials";
import {
    requireAuth,
    requireAdmin,
    generateToken,
    generateRefreshToken,
    generateStreamTicket,
    STREAM_TICKET_TTL_SECONDS,
    JWT_SECRET_VALIDATED,
    invalidateUserCache,
} from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimiter";
import { webLoginGuesses } from "../services/users/guessLimits";
import { encrypt, decrypt } from "../utils/encryption";

const router = Router();

const loginSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
});

// POST /auth/login
router.post("/login", async (req, res) => {
    try {
        const { username, password } = loginSchema.parse(req.body);
        // The two-factor code, if sent; a client may send it as a number.
        const token = req.body.token == null || req.body.token === "" ? undefined : String(req.body.token);

        const user = await prisma.user.findUnique({ where: { username } });

        if (!webLoginGuesses.take(username)) {
            return res.status(429).json({ error: "Too many login attempts, please try again in 15 minutes." });
        }

        const valid = await bcrypt.compare(password, user?.passwordHash ?? NO_ACCOUNT_PASSWORD_HASH);
        if (!user || !valid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Check if 2FA is enabled
        if (user.twoFactorEnabled && user.twoFactorSecret) {
            if (!token) {
                webLoginGuesses.giveBack(username);
                return res.status(200).json({
                    requires2FA: true,
                    message: "2FA token required",
                });
            }

            // Check if it's a recovery code
            const isRecoveryCode = /^[A-F0-9]{8}$/i.test(token);

            if (isRecoveryCode && user.twoFactorRecoveryCodes) {
                const encryptedCodes = user.twoFactorRecoveryCodes;
                const decryptedCodes = decrypt(encryptedCodes);
                const hashedCodes = decryptedCodes.split(",");

                const providedHash = crypto
                    .createHash("sha256")
                    .update(token.toUpperCase())
                    .digest("hex");

                const codeIndex = hashedCodes.indexOf(providedHash);
                if (codeIndex === -1) {
                    return res
                        .status(401)
                        .json({ error: "Invalid recovery code" });
                }

                hashedCodes.splice(codeIndex, 1);
                await prisma.user.update({
                    where: { id: user.id },
                    data: {
                        twoFactorRecoveryCodes: encrypt(
                            hashedCodes.join(",")
                        ),
                    },
                });
            } else {
                if (!totpMatches(decrypt(user.twoFactorSecret), token)) {
                    return res.status(401).json({ error: "Invalid 2FA token" });
                }
            }
        }

        webLoginGuesses.giveBack(username);

        // Generate JWT tokens
        const jwtToken = generateToken({
            id: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
        });
        const refreshToken = generateRefreshToken({
            id: user.id,
            tokenVersion: user.tokenVersion,
        });

        res.json({
            token: jwtToken,
            refreshToken: refreshToken,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.issues });
        }
        logger.error("Login error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

// POST /auth/logout: tokens are stateless, so signing out is the client dropping its token.
router.post("/logout", (_req, res) => {
    res.json({ message: "Logged out" });
});

// POST /auth/refresh - Refresh access token using refresh token
router.post("/refresh", authLimiter, async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        return res.status(400).json({ error: "Refresh token required" });
    }

    try {
        const decoded = jwt.verify(refreshToken, JWT_SECRET_VALIDATED) as any;

        if (decoded.type !== "refresh") {
            return res.status(401).json({ error: "Invalid refresh token" });
        }

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                username: true,
                role: true,
                tokenVersion: true,
            },
        });

        if (!user) {
            return res.status(401).json({ error: "User not found" });
        }

        // Validate tokenVersion
        if (decoded.tokenVersion !== user.tokenVersion) {
            return res.status(401).json({ error: "Token invalidated" });
        }

        const newAccessToken = generateToken(user);
        const newRefreshToken = generateRefreshToken(user);

        return res.json({
            token: newAccessToken,
            refreshToken: newRefreshToken,
        });
    } catch (error) {
        return res.status(401).json({ error: "Invalid refresh token" });
    }
});

// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: {
                id: true,
                username: true,
                role: true,
                onboardingComplete: true,
                createdAt: true,
            },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json(user);
    } catch (error) {
        logger.error("Get current user error:", error);
        res.status(500).json({ error: "Internal error" });
    }
});

// POST /auth/change-password
router.post("/change-password", requireAuth, authLimiter, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res
                .status(400)
                .json({ error: "Current and new password are required" });
        }

        if (newPassword.length < 6) {
            return res
                .status(400)
                .json({ error: "New password must be at least 6 characters" });
        }

        // Verify current password
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { id: true, passwordHash: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) {
            // 401 means "not signed in"; a wrong password from a signed-in user is a bad request.
            return res
                .status(400)
                .json({ error: "Current password is incorrect" });
        }

        // A new tokenVersion signs out every other device; this one gets fresh tokens.
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        const updated = await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                passwordHash: newPasswordHash,
                tokenVersion: { increment: 1 },
            },
            select: { id: true, username: true, role: true, tokenVersion: true },
        });
        // The auth layer caches the user row, and tokenVersion is what revokes
        // issued tokens -- without this the old tokens keep working until the
        // cache TTL elapses.
        invalidateUserCache(req.user!.id);

        res.json({
            message: "Password changed successfully",
            token: generateToken(updated),
            refreshToken: generateRefreshToken({ id: updated.id, tokenVersion: updated.tokenVersion }),
        });
    } catch (error) {
        logger.error("Change password error:", error);
        res.status(500).json({ error: "Failed to change password" });
    }
});

// GET /auth/users (Admin only)
router.get("/users", requireAuth, requireAdmin, async (_req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                username: true,
                role: true,
                onboardingComplete: true,
                createdAt: true,
            },
            orderBy: { createdAt: "asc" },
        });

        res.json(users);
    } catch (error) {
        logger.error("Get users error:", error);
        res.status(500).json({ error: "Failed to get users" });
    }
});

// POST /auth/create-user (Admin only)
router.post("/create-user", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (!username || !password) {
            return res
                .status(400)
                .json({ error: "Username and password are required" });
        }

        if (password.length < 6) {
            return res
                .status(400)
                .json({ error: "Password must be at least 6 characters" });
        }

        if (role && !["user", "admin"].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        // Check if username exists
        const existing = await prisma.user.findUnique({
            where: { username },
        });

        if (existing) {
            return res.status(400).json({ error: "Username already taken" });
        }

        // Create user
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                username,
                passwordHash,
                role: role || "user",
                onboardingComplete: true, // Skip onboarding for created users
            },
        });

        // Create default user settings
        await prisma.userSettings.create({
            data: defaultUserSettingsFor(user.id),
        });

        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            createdAt: user.createdAt,
        });
    } catch (error) {
        logger.error("Create user error:", error);
        res.status(500).json({ error: "Failed to create user" });
    }
});

// DELETE /auth/users/:id (Admin only)
router.delete("/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting yourself
        if (id === req.user!.id) {
            return res
                .status(400)
                .json({ error: "Cannot delete your own account" });
        }

        // Every User relation cascades on delete.
        await prisma.user.delete({
            where: { id },
        });

        // The auth layer caches user rows for 30 s, so drop this one now or the
        // deleted user's tokens keep working until it expires.
        invalidateUserCache(id);

        res.json({ message: "User deleted successfully" });
    } catch (error: any) {
        logger.error("Delete user error:", error);
        if (error.code === "P2025") {
            return res.status(404).json({ error: "User not found" });
        }
        res.status(500).json({ error: "Failed to delete user" });
    }
});

// POST /auth/2fa/setup - Generate 2FA secret and QR code
router.post("/2fa/setup", requireAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { username: true, twoFactorEnabled: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (user.twoFactorEnabled) {
            return res.status(400).json({ error: "2FA is already enabled" });
        }

        // Generate secret
        const secret = speakeasy.generateSecret({
            name: `Kima (${user.username})`,
            issuer: "Kima",
        });

        // Generate QR code
        const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url!);

        res.json({
            secret: secret.base32,
            qrCode: qrCodeDataUrl,
        });
    } catch (error) {
        logger.error("2FA setup error:", error);
        res.status(500).json({ error: "Failed to setup 2FA" });
    }
});

// POST /auth/2fa/enable - Verify token and enable 2FA
router.post("/2fa/enable", requireAuth, authLimiter, async (req, res) => {
    try {
        const { secret, token } = req.body;

        if (!secret || !token) {
            return res
                .status(400)
                .json({ error: "Secret and token are required" });
        }

        if (!totpMatches(secret, token)) {
            return res
                .status(400)
                .json({ error: "Invalid token. Please try again." });
        }

        // Generate 10 recovery codes
        const recoveryCodes: string[] = [];
        const hashedRecoveryCodes: string[] = [];

        for (let i = 0; i < 10; i++) {
            // Eight hex characters, stored only as a hash.
            const code = crypto.randomBytes(4).toString("hex").toUpperCase();
            recoveryCodes.push(code);
            hashedRecoveryCodes.push(
                crypto.createHash("sha256").update(code).digest("hex")
            );
        }

        // Encrypt the hashed codes for storage
        const encryptedRecoveryCodes = encrypt(
            hashedRecoveryCodes.join(",")
        );

        // Encrypt and save the secret
        const encryptedSecret = encrypt(secret);
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                twoFactorEnabled: true,
                twoFactorSecret: encryptedSecret,
                twoFactorRecoveryCodes: encryptedRecoveryCodes,
            },
        });

        // Return the plain recovery codes to the user (only time they'll see them)
        res.json({
            message: "2FA enabled successfully",
            recoveryCodes: recoveryCodes,
        });
    } catch (error) {
        logger.error("2FA enable error:", error);
        res.status(500).json({ error: "Failed to enable 2FA" });
    }
});

// POST /auth/2fa/disable - Disable 2FA
router.post("/2fa/disable", requireAuth, authLimiter, async (req, res) => {
    try {
        const { password, token } = req.body;

        if (!password || !token) {
            return res
                .status(400)
                .json({ error: "Password and current 2FA token are required" });
        }

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { id: true, passwordHash: true, twoFactorSecret: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            return res.status(400).json({ error: "Invalid password" });
        }

        if (user.twoFactorSecret) {
            if (!totpMatches(decrypt(user.twoFactorSecret), token)) {
                return res.status(400).json({ error: "Invalid 2FA token" });
            }
        }

        // Disable 2FA
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                twoFactorEnabled: false,
                twoFactorSecret: null,
                twoFactorRecoveryCodes: null,
            },
        });

        res.json({ message: "2FA disabled successfully" });
    } catch (error) {
        logger.error("2FA disable error:", error);
        res.status(500).json({ error: "Failed to disable 2FA" });
    }
});

// POST /auth/stream-ticket - Mint a short-lived, stream-scoped JWT for AVPlayer URLs.
// Accepts the same header auth as other API calls (Bearer JWT or x-api-key).
// Response: { ticket: string, expiresIn: number (seconds) }
router.post("/stream-ticket", requireAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { id: true, tokenVersion: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const ticket = generateStreamTicket(user);
        return res.json({ ticket, expiresIn: STREAM_TICKET_TTL_SECONDS });
    } catch (error) {
        logger.error("Stream ticket error:", error);
        return res.status(500).json({ error: "Failed to mint stream ticket" });
    }
});

// DELETE /auth/account - Delete the current user's own account
router.delete("/account", requireAuth, async (req, res) => {
    try {
        await prisma.$transaction(
            async (tx) => {
                // Last-admin guard INSIDE the txn so count-then-delete is atomic under
                // Serializable isolation: two concurrent admin deletions can't both see
                // count>1 and leave the instance with zero admins (a bricked instance).
                if (req.user!.role === "admin") {
                    const adminCount = await tx.user.count({
                        where: { role: "admin" },
                    });
                    if (adminCount <= 1) {
                        throw new Error("LAST_ADMIN_GUARD");
                    }
                }

                // Every User relation cascades on delete.
                await tx.user.delete({ where: { id: req.user!.id } });
            },
            { isolationLevel: "Serializable" }
        );

        // Drop the cached user row so the deleted account's tokens stop working now.
        // After the commit, so it runs only once the delete is real.
        invalidateUserCache(req.user!.id);

        return res.json({ deleted: true });
    } catch (error: any) {
        if (error?.message === "LAST_ADMIN_GUARD") {
            return res.status(409).json({
                error: "Cannot delete the only administrator account",
            });
        }
        // Serializable conflict from a concurrent admin change — safe to retry.
        if (error?.code === "P2034") {
            return res.status(409).json({
                error: "Concurrent account change, please retry",
            });
        }
        logger.error("Account deletion error:", error);
        return res.status(500).json({ error: "Failed to delete account" });
    }
});

// GET /auth/2fa/status - Check if 2FA is enabled
router.get("/2fa/status", requireAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { twoFactorEnabled: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json({ enabled: user.twoFactorEnabled });
    } catch (error) {
        logger.error("2FA status error:", error);
        res.status(500).json({ error: "Failed to get 2FA status" });
    }
});

export default router;
