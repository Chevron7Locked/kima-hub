import { Response, Router } from "express";
import { logger } from "../utils/logger";
import bcrypt from "bcrypt";
import { prisma } from "../utils/db";
import { z } from "zod";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import jwt from "jsonwebtoken";
import { isRecoveryCodeShaped, newRecoveryCodes, NO_ACCOUNT_PASSWORD_HASH, normalizeSecondFactor, readPendingTwoFactorSecret, readTwoFactorSecret, replaceRecoveryCodes, spendSecondFactor, totpStep, warnIfRecoveryListUnreadable } from "../services/users/credentials";
import { changePassword, createAccount, deleteAccount, findUserByUsername, LastAdminError, normalizeUsername, refusalMessage } from "../services/users/accounts";
import {
    generateToken,
    generateRefreshToken,
    generateStreamTicket,
    STREAM_TICKET_TTL_SECONDS,
    JWT_SECRET_VALIDATED,
    invalidateUserCache,
} from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimiter";
import { passwordGuessSubject, webLoginGuesses } from "../services/users/guessLimits";
import { encrypt } from "../utils/encryption";
import { isTransactionConflict } from "../utils/dbConflict";

const router = Router();

const ALREADY_ENABLED = "2FA is already enabled";
const SETUP_AGAIN = "Start setup again: there is no 2FA setup waiting, or it timed out";
const UNREADABLE_SECRET = "2FA is on but its secret cannot be read, so it was left on";
const UNREADABLE_SECRET_CODES = "2FA is on but its secret cannot be read, so the recovery codes were left as they were";

const RECOVERY_CHANGED = "Recovery codes changed, try again";

/** A code as typed: spaces and dashes dropped, a recovery code in upper case. Nothing left is a 400. */
const secondFactor = z.string().transform(normalizeSecondFactor).pipe(z.string().min(1));

/** The bodies of the 2FA routes: strings only. Anything else is a 400. A `secret` the client still sends is ignored. */
const setupBody = z.object({}).optional();
const enableBody = z.object({ token: secondFactor });
const proveBody = z.object({ password: z.string().min(1), token: secondFactor });

/** A zod refusal as the 400 the routes answer; null when the error is something else. */
function invalidBody(err: unknown, res: Response): Response | null {
    if (!(err instanceof z.ZodError)) return null;
    return res.status(400).json({ error: "Invalid request", details: err.issues });
}

const loginSchema = z.object({
    username: z.string().refine((name) => normalizeUsername(name) !== ""),
    password: z.string().min(1),
});

// POST /auth/login
router.post("/login", async (req, res) => {
    try {
        const { username: given, password } = loginSchema.parse(req.body);
        // The two-factor code, if sent; a client may send it as a number. A code that is only spaces counts as not sent.
        const typed = req.body.token == null ? "" : normalizeSecondFactor(String(req.body.token));
        const token = typed === "" ? undefined : typed;

        const user = await findUserByUsername(given, {
            id: true,
            username: true,
            role: true,
            passwordHash: true,
            twoFactorEnabled: true,
            twoFactorSecret: true,
            twoFactorRecoveryCodes: true,
            tokenVersion: true,
        });

        // Counted against the account the typed name reached, or the trimmed name when it reached none.
        const guessSubject = passwordGuessSubject(given, user);
        const guess = webLoginGuesses.take(guessSubject);
        if (!guess) {
            return res.status(429).json({ error: "Too many login attempts, please try again in 15 minutes." });
        }

        const valid = await bcrypt.compare(password, user?.passwordHash ?? NO_ACCOUNT_PASSWORD_HASH);
        if (!user || !valid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        // Check if 2FA is enabled
        if (user.twoFactorEnabled) {
            // A secret that is missing or the key cannot read is not "no second factor": the sign-in is refused and
            // the stored value is left as it is.
            const secret = readTwoFactorSecret(user.id, user.twoFactorSecret);
            if (secret === null) {
                // The password was right, so this is not a wrong guess: it must not count toward locking the account.
                webLoginGuesses.giveBack(guess);
                return res.status(401).json({ error: "Two-factor sign-in is unavailable for this account" });
            }

            if (!token) {
                webLoginGuesses.giveBack(guess);
                return res.status(200).json({
                    requires2FA: true,
                    message: "2FA token required",
                });
            }

            // Once per sign-in that sends a code, so an unreadable recovery list shows in the log whatever code was sent.
            warnIfRecoveryListUnreadable(user.id, user.twoFactorRecoveryCodes);

            // A recovery code is spent atomically, so of two sign-ins sending one, one is refused. An authenticator
            // code is spent by use: the same one, or an earlier step's, is refused a second time.
            const spent = await spendSecondFactor({ id: user.id, recoveryCodes: user.twoFactorRecoveryCodes }, secret, token);
            if (!spent) {
                return res.status(401).json({ error: isRecoveryCodeShaped(token) ? "Invalid recovery code" : "Invalid 2FA token" });
            }
        }

        webLoginGuesses.giveBack(guess);

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
    } catch {
        return res.status(401).json({ error: "Invalid refresh token" });
    }
});

// GET /auth/me
router.get("/me", async (req, res) => {
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
router.post("/change-password", authLimiter, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
            return res
                .status(400)
                .json({ error: "Current and new password are required" });
        }

        const changed = await changePassword({ userId: req.user!.id, currentPassword, newPassword });
        if (!changed.ok) {
            if (changed.reason === "password-too-short" || changed.reason === "password-too-long") {
                return res.status(400).json({ error: refusalMessage(changed, "New password") });
            }
            if (changed.reason === "not-found") {
                return res.status(404).json({ error: "User not found" });
            }
            // 401 means "not signed in"; a wrong password from a signed-in user is a bad request.
            return res.status(400).json({ error: "Current password is incorrect" });
        }
        const updated = changed.user;

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
router.get("/users", async (_req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                username: true,
                role: true,
                onboardingComplete: true,
                twoFactorEnabled: true,
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
router.post("/create-user", async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
            return res
                .status(400)
                .json({ error: "Username and password are required" });
        }

        if (role && !["user", "admin"].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        // Skips onboarding: an admin made this account.
        const made = await createAccount({
            username,
            password,
            role: role || "user",
            onboardingComplete: true,
        });
        if (!made.ok) {
            if (made.reason === "username-taken") {
                return res.status(400).json({ error: "Username already taken" });
            }
            return res.status(400).json({ error: refusalMessage(made) });
        }
        const user = made.user;

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
router.delete("/users/:id", async (req, res) => {
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

// POST /auth/2fa/setup - Make a secret and QR code, and keep the secret (sealed) until a code proves it
router.post("/2fa/setup", async (req, res) => {
    try {
        setupBody.parse(req.body);
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { username: true, twoFactorEnabled: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (user.twoFactorEnabled) {
            return res.status(400).json({ error: ALREADY_ENABLED });
        }

        // Generate secret
        const secret = speakeasy.generateSecret({
            name: `Kima (${user.username})`,
            issuer: "Kima",
        });

        // Generate QR code
        const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url!);

        // Kept on the server for ten minutes; a new setup replaces it. Enable checks its code against this one, so a
        // secret the client names never counts. Written only while it is off, so a setup cannot slip in behind an enable.
        const kept = await prisma.user.updateMany({
            where: { id: req.user!.id, twoFactorEnabled: false },
            data: { twoFactorPendingSecret: encrypt(secret.base32), twoFactorPendingAt: new Date(Date.now()) },
        });
        if (kept.count !== 1) {
            return res.status(400).json({ error: ALREADY_ENABLED });
        }

        res.json({
            secret: secret.base32,
            qrCode: qrCodeDataUrl,
        });
    } catch (error) {
        if (invalidBody(error, res)) return;
        logger.error("2FA setup error:", error);
        res.status(500).json({ error: "Failed to setup 2FA" });
    }
});

// POST /auth/2fa/enable - Check a code against the secret setup kept, and turn 2FA on
router.post("/2fa/enable", authLimiter, async (req, res) => {
    try {
        // A `secret` in the body is read by nobody: older clients still send it.
        const { token } = enableBody.parse(req.body);

        // While it is on, it is turned off first (which needs the password and a current code); a new secret does
        // not replace the one in use.
        const current = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { twoFactorEnabled: true, twoFactorLastStep: true, twoFactorPendingSecret: true, twoFactorPendingAt: true },
        });
        if (!current) {
            return res.status(404).json({ error: "User not found" });
        }
        if (current.twoFactorEnabled) {
            return res.status(400).json({ error: ALREADY_ENABLED });
        }

        const secret = readPendingTwoFactorSecret(current.twoFactorPendingSecret, current.twoFactorPendingAt);
        if (secret === null) {
            return res.status(400).json({ error: SETUP_AGAIN });
        }

        const step = totpStep(secret, token);
        if (step === null) {
            return res
                .status(400)
                .json({ error: "Invalid token. Please try again." });
        }

        const recovery = newRecoveryCodes();

        // Written only if it is still off and the pending secret is still the one checked, so two requests cannot
        // both turn it on, and a setup run in between is not overwritten.
        const written = await prisma.user.updateMany({
            where: { id: req.user!.id, twoFactorEnabled: false, twoFactorPendingSecret: current.twoFactorPendingSecret },
            data: {
                twoFactorEnabled: true,
                twoFactorSecret: encrypt(secret),
                twoFactorRecoveryCodes: recovery.stored,
                twoFactorPendingSecret: null,
                twoFactorPendingAt: null,
                // The code that proved the secret is spent, so it cannot also sign in. A step spent before stays
                // spent: an older code does not move the mark back.
                twoFactorLastStep: Math.max(step, current.twoFactorLastStep),
            },
        });
        if (written.count !== 1) {
            const now = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { twoFactorEnabled: true } });
            return res.status(400).json({ error: now?.twoFactorEnabled ? ALREADY_ENABLED : SETUP_AGAIN });
        }

        logger.info(`[2FA] ${req.user!.id} turned on 2FA`);

        // Return the plain recovery codes to the user (only time they'll see them)
        res.json({
            message: "2FA enabled successfully",
            recoveryCodes: recovery.codes,
        });
    } catch (error) {
        if (invalidBody(error, res)) return;
        logger.error("2FA enable error:", error);
        res.status(500).json({ error: "Failed to enable 2FA" });
    }
});

// POST /auth/2fa/disable - Disable 2FA with the password and a current authenticator code or a recovery code
router.post("/2fa/disable", authLimiter, async (req, res) => {
    try {
        const { password, token } = proveBody.parse(req.body);

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { id: true, passwordHash: true, twoFactorEnabled: true, twoFactorSecret: true, twoFactorRecoveryCodes: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            return res.status(400).json({ error: "Invalid password" });
        }

        if (user.twoFactorEnabled) {
            // A secret that is missing or unreadable cannot check a code, and is not a reason to skip the check:
            // it stays on, stored as it is, until the key that reads it is restored or an admin resets it.
            const secret = readTwoFactorSecret(user.id, user.twoFactorSecret);
            if (secret === null) {
                return res.status(409).json({ error: UNREADABLE_SECRET });
            }
            // Spent like a sign-in's code: one just used to sign in cannot also turn it off, and a recovery code is
            // taken the way a sign-in takes it, so a person who lost their phone can still turn it off.
            const spent = await spendSecondFactor({ id: user.id, recoveryCodes: user.twoFactorRecoveryCodes }, secret, token);
            if (!spent) {
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
                twoFactorPendingSecret: null,
                twoFactorPendingAt: null,
                // Nothing is spent once there is no secret: a later setup starts from no spent step.
                twoFactorLastStep: 0,
            },
        });

        if (user.twoFactorEnabled) logger.info(`[2FA] ${user.id} turned off 2FA`);

        res.json({ message: "2FA disabled successfully" });
    } catch (error) {
        if (invalidBody(error, res)) return;
        logger.error("2FA disable error:", error);
        res.status(500).json({ error: "Failed to disable 2FA" });
    }
});

// POST /auth/2fa/recovery-codes - Replace the whole recovery list with ten new codes, shown once. 2FA stays on.
router.post("/2fa/recovery-codes", authLimiter, async (req, res) => {
    try {
        const { password, token } = proveBody.parse(req.body);

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { id: true, passwordHash: true, twoFactorEnabled: true, twoFactorSecret: true, twoFactorRecoveryCodes: true },
        });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (!(await bcrypt.compare(password, user.passwordHash))) {
            return res.status(400).json({ error: "Invalid password" });
        }
        if (!user.twoFactorEnabled) {
            return res.status(400).json({ error: "2FA is not enabled" });
        }

        const secret = readTwoFactorSecret(user.id, user.twoFactorSecret);
        if (secret === null) {
            return res.status(409).json({ error: UNREADABLE_SECRET_CODES });
        }
        if (!(await spendSecondFactor({ id: user.id, recoveryCodes: user.twoFactorRecoveryCodes }, secret, token))) {
            return res.status(400).json({ error: "Invalid 2FA token" });
        }

        // The old list goes, readable or not: a person who proved a current code gets a list they can use. Spending a
        // recovery code changed the list, so it is read again, and only that list is written over: if another request
        // changed it since, this one is told to try again and nothing it made is kept.
        const read = await prisma.user.findUnique({ where: { id: user.id }, select: { twoFactorRecoveryCodes: true } });
        const codes = await replaceRecoveryCodes(user.id, read?.twoFactorRecoveryCodes ?? null);
        if (codes === null) {
            const now = await prisma.user.findUnique({ where: { id: user.id }, select: { twoFactorEnabled: true } });
            return now?.twoFactorEnabled
                ? res.status(409).json({ error: RECOVERY_CHANGED })
                : res.status(400).json({ error: "2FA is not enabled" });
        }

        logger.info(`[2FA] ${user.id} made new recovery codes`);

        res.json({ recoveryCodes: codes });
    } catch (error) {
        if (invalidBody(error, res)) return;
        logger.error("2FA recovery codes error:", error);
        res.status(500).json({ error: "Failed to make new recovery codes" });
    }
});

// POST /auth/users/:id/reset-2fa (Admin only) - Turn 2FA off for a person who cannot sign in with it, readable or not
router.post("/users/:id/reset-2fa", async (req, res) => {
    try {
        const reset = await prisma.user.updateMany({
            where: { id: req.params.id },
            data: {
                twoFactorEnabled: false,
                twoFactorSecret: null,
                twoFactorRecoveryCodes: null,
                twoFactorPendingSecret: null,
                twoFactorPendingAt: null,
                twoFactorLastStep: 0,
            },
        });
        if (reset.count !== 1) {
            return res.status(404).json({ error: "User not found" });
        }
        invalidateUserCache(req.params.id);
        logger.info(`[2FA] admin ${req.user?.id} turned off 2FA for ${req.params.id}`);
        res.json({ message: "2FA turned off" });
    } catch (error) {
        logger.error("2FA reset error:", error);
        res.status(500).json({ error: "Failed to reset 2FA" });
    }
});

// POST /auth/stream-ticket - Mint a short-lived, stream-scoped JWT for AVPlayer URLs.
// Accepts the same header auth as other API calls (Bearer JWT or x-api-key).
// Response: { ticket: string, expiresIn: number (seconds) }
router.post("/stream-ticket", async (req, res) => {
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
router.delete("/account", async (req, res) => {
    try {
        await deleteAccount(req.user!.id);
        return res.json({ deleted: true });
    } catch (error) {
        if (error instanceof LastAdminError) {
            return res.status(409).json({
                error: error.message,
            });
        }
        // Serializable conflict from a concurrent admin change — safe to retry.
        if (isTransactionConflict(error)) {
            return res.status(409).json({
                error: "Concurrent account change, please retry",
            });
        }
        logger.error("Account deletion error:", error);
        return res.status(500).json({ error: "Failed to delete account" });
    }
});

// GET /auth/2fa/status - Check if 2FA is enabled
router.get("/2fa/status", async (req, res) => {
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
