import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { prisma } from "../utils/db";
import { subsonicError, SubsonicError } from "../utils/subsonicResponse";

export async function subsonicAuth(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const username = req.query.u as string | undefined;
    const apiKey = req.query.apiKey as string | undefined;
    const password = req.query.p as string | undefined;
    const tokenMd5 = req.query.t as string | undefined;

    if (!username) {
        subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: u");
        return;
    }

    try {
        // MD5 token auth — verify against the user's API keys.
        // Standard Subsonic clients send t=md5(password+salt)&s=salt. Since Kima
        // stores bcrypt hashes it cannot verify against the login password, so the
        // user enters an API key as the "password" in their client. The server
        // computes md5(apiKey+salt) for each of the user's keys and checks for a match.
        if (tokenMd5) {
            const salt = req.query.s as string | undefined;
            if (!salt) {
                subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: s");
                return;
            }

            const user = await prisma.user.findUnique({
                where: { username },
                select: { id: true, username: true, role: true },
            });

            if (!user) {
                subsonicError(req, res, SubsonicError.WRONG_CREDENTIALS, "Wrong username or password");
                return;
            }

            const apiKeys = await prisma.apiKey.findMany({
                where: { userId: user.id },
                select: { id: true, key: true },
            });

            let matchedKeyId: string | null = null;
            for (const k of apiKeys) {
                const expected = crypto.createHash("md5").update(k.key + salt).digest("hex");
                if (expected === tokenMd5) {
                    matchedKeyId = k.id;
                    break;
                }
            }

            if (!matchedKeyId) {
                subsonicError(req, res, SubsonicError.WRONG_CREDENTIALS, "Wrong username or password");
                return;
            }

            prisma.apiKey.update({ where: { id: matchedKeyId }, data: { lastUsed: new Date() } }).catch(() => {});

            req.user = user;
            next();
            return;
        }

        // OpenSubsonic API key auth (preferred)
        if (apiKey) {
            const keyRecord = await prisma.apiKey.findUnique({
                where: { key: apiKey },
                include: {
                    user: { select: { id: true, username: true, role: true } },
                },
            });

            if (!keyRecord || keyRecord.user.username !== username) {
                subsonicError(req, res, SubsonicError.WRONG_CREDENTIALS, "Wrong username or password");
                return;
            }

            // Update lastUsed non-blocking
            prisma.apiKey
                .update({ where: { id: keyRecord.id }, data: { lastUsed: new Date() } })
                .catch(() => {});

            req.user = keyRecord.user;
            next();
            return;
        }

        // Legacy plaintext password auth
        if (password) {
            // Subsonic "enc:" prefix means hex-encoded password
            const plainPassword = password.startsWith("enc:")
                ? Buffer.from(password.slice(4), "hex").toString("utf8")
                : password;

            const user = await prisma.user.findUnique({
                where: { username },
                select: { id: true, username: true, role: true, passwordHash: true },
            });

            // Timing-safe: always run bcrypt.compare to prevent username enumeration
            const dummyHash = "$2b$10$invalidhashfortimingsafety.00000000000000000000";
            let valid = false;
            if (user) {
                valid = await bcrypt.compare(plainPassword, user.passwordHash);
            } else {
                // Run bcrypt against a dummy hash for timing safety (prevents username enumeration)
                await bcrypt.compare(plainPassword, dummyHash);
                // valid remains false
            }

            if (!valid || !user) {
                subsonicError(req, res, SubsonicError.WRONG_CREDENTIALS, "Wrong username or password");
                return;
            }

            req.user = { id: user.id, username: user.username, role: user.role };
            next();
            return;
        }

        subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: p or apiKey");
    } catch (_err) {
        subsonicError(req, res, SubsonicError.GENERIC, "Authentication error");
    }
}
