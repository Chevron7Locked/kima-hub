import { Router } from "express";
import { logger } from "../utils/logger";
import bcrypt from "bcrypt";
import { prisma } from "../utils/db";
import { z } from "zod";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { requireAuth, requireAdmin, generateToken, generateRefreshToken } from "../middleware/auth";
import { encrypt, decrypt } from "../utils/encryption";

const router = Router();

const loginSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
});

// Use shared encryption module for 2FA secrets
const encrypt2FASecret = encrypt;
const decrypt2FASecret = decrypt;

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Login with username and password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /auth/login
router.post("/login", async (req, res) => {
    try {
        const { username, password } = loginSchema.parse(req.body);
        const { token } = req.body; // 2FA token if provided

        const user = await prisma.user.findUnique({ where: { username } });
        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Check if 2FA is enabled
        if (user.twoFactorEnabled && user.twoFactorSecret) {
            if (!token) {
                return res.status(200).json({
                    requires2FA: true,
                    message: "2FA token required",
                    userId: user.id, // Send userId for next 2FA request
                });
            }

            // Check if it's a recovery code
            const isRecoveryCode = /^[A-F0-9]{8}$/i.test(token);

            if (isRecoveryCode && user.twoFactorRecoveryCodes) {
                const encryptedCodes = user.twoFactorRecoveryCodes;
                const decryptedCodes = decrypt2FASecret(encryptedCodes);
                const hashedCodes = decryptedCodes.split(",");

                const providedHash = crypto
                    .createHash("sha256")
                    .update(token.toUpperCase())
                    .digest("hex");

                const codeIndex = hashedCodes.indexOf(providedHash);
                if (codeIndex === -1) {
                    return res.status(401).json({ error: "Invalid recovery code" });
                }

                hashedCodes.splice(codeIndex, 1);
                await prisma.user.update({
                    where: { id: user.id },
                    data: { twoFactorRecoveryCodes: encrypt2FASecret(hashedCodes.join(",")) },
                });
            } else {
                // Verify TOTP token
                const secret = decrypt2FASecret(user.twoFactorSecret);
                const verified = speakeasy.totp.verify({
                    secret,
                    encoding: "base32",
                    token,
                    window: 2,
                });

                if (!verified) {
                    return res.status(401).json({ error: "Invalid 2FA token" });
                }
            }
        }

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
            return res.status(400).json({ error: "Invalid request", details: err.errors });
        }
        logger.error("Login error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

// POST /auth/logout - JWT is stateless, logout is handled client-side
router.post("/logout", (req, res) => {
    // With JWT, logout is handled by client removing the token
    // No server-side session to destroy
    res.json({ message: "Logged out" });
});

// POST /auth/refresh - Refresh access token using refresh token
router.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
        return res.status(400).json({ error: "Refresh token required" });
    }
    
    try {
        const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET || process.env.SESSION_SECRET!) as any;
        
        if (decoded.type !== "refresh") {
            return res.status(401).json({ error: "Invalid refresh token" });
        }
        
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, username: true, role: true, tokenVersion: true }
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
            refreshToken: newRefreshToken
        });
    } catch (error) {
        return res.status(401).json({ error: "Invalid refresh token" });
    }
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Current user information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
            id: true,
            username: true,
            role: true,
            onboardingComplete: true,
            enrichmentSettings: true,
            createdAt: true,
        },
    });

    if (!user) {
        return res.status(404).json({ error: "User not found" });
    }

    res.json(user);
});

// POST /auth/change-password
router.post("/change-password", requireAuth, async (req, res) => {
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
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) {
            return res
                .status(401)
                .json({ error: "Current password is incorrect" });
        }

        // Update password and increment tokenVersion to invalidate all existing tokens
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                passwordHash: newPasswordHash,
                tokenVersion: { increment: 1 }
            },
        });

        res.json({ message: "Password changed successfully" });
    } catch (error) {
        logger.error("Change password error:", error);
        res.status(500).json({ error: "Failed to change password" });
    }
});

// GET /auth/users (Admin only)
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
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
            data: {
                userId: user.id,
                playbackQuality: "original",
                wifiOnly: false,
                offlineEnabled: false,
                maxCacheSizeMb: 10240,
            },
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

        // Delete user (cascade will handle related data)
        await prisma.user.delete({
            where: { id },
        });

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
            name: `Lidify (${user.username})`,
            issuer: "Lidify",
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
router.post("/2fa/enable", requireAuth, async (req, res) => {
    try {
        const { secret, token } = req.body;

        if (!secret || !token) {
            return res
                .status(400)
                .json({ error: "Secret and token are required" });
        }

        // Verify the token with the secret
        const verified = speakeasy.totp.verify({
            secret,
            encoding: "base32",
            token,
            window: 2,
        });

        if (!verified) {
            return res
                .status(401)
                .json({ error: "Invalid token. Please try again." });
        }

        // Generate 10 recovery codes
        const recoveryCodes: string[] = [];
        const hashedRecoveryCodes: string[] = [];

        for (let i = 0; i < 10; i++) {
            // Generate 8-character alphanumeric code
            const code = crypto.randomBytes(4).toString("hex").toUpperCase();
            recoveryCodes.push(code);
            // Hash the code before storing
            hashedRecoveryCodes.push(
                crypto.createHash("sha256").update(code).digest("hex")
            );
        }

        // Encrypt the hashed codes for storage
        const encryptedRecoveryCodes = encrypt2FASecret(
            hashedRecoveryCodes.join(",")
        );

        // Encrypt and save the secret
        const encryptedSecret = encrypt2FASecret(secret);
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
router.post("/2fa/disable", requireAuth, async (req, res) => {
    try {
        const { password, token } = req.body;

        if (!password || !token) {
            return res
                .status(400)
                .json({ error: "Password and current 2FA token are required" });
        }

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            return res.status(401).json({ error: "Invalid password" });
        }

        // Verify 2FA token
        if (user.twoFactorSecret) {
            const secret = decrypt2FASecret(user.twoFactorSecret);
            const verified = speakeasy.totp.verify({
                secret,
                encoding: "base32",
                token,
                window: 2,
            });

            if (!verified) {
                return res.status(401).json({ error: "Invalid 2FA token" });
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
