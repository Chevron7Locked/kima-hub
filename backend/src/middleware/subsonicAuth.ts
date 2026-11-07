import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { NO_ACCOUNT_PASSWORD_HASH } from "../services/users/credentials";
import { prisma } from "../utils/db";
import { subsonicError, SubsonicError } from "../utils/subsonicResponse";
import { findApiKeyUser } from "../services/users/apiKeyStore";
import { subsonicGuesses } from "../services/users/guessLimits";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Which credential authenticated this Subsonic request. changePassword.view
             * refuses a self-change made with an API key. */
            subsonicAuthMethod?: "password" | "apiKey";
        }
    }
}

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
        // MD5 token auth (t=, s=) needs the plaintext secret on the server. API keys
        // are stored as SHA-256 digests and passwords as bcrypt, so it cannot be
        // answered; clients get the protocol's TOKEN_AUTH_NOT_SUPPORTED (41) and use
        // apiKey= or the password field instead.
        if (tokenMd5) {
            subsonicError(
                req,
                res,
                SubsonicError.TOKEN_AUTH_NOT_SUPPORTED,
                "Token authentication is not supported. Use an API key (apiKey=) or your account password.",
            );
            return;
        }

        // OpenSubsonic API key auth (preferred)
        if (apiKey) {
            const keyUser = await findApiKeyUser(apiKey);
            if (!keyUser || keyUser.username !== username) {
                subsonicError(req, res, SubsonicError.WRONG_CREDENTIALS, "Wrong username or password");
                return;
            }

            req.user = keyUser;
            // A provisioned app credential, not the account password -- see
            // the 2FA note on the password branch below for why this
            // distinction has to survive past this middleware, not just gate
            // entry here.
            req.subsonicAuthMethod = "apiKey";
            next();
            return;
        }

        // p= accepts an API key first: native clients (Amperfy, Symfonium, DSub) can
        // only carry a token in their password field.
        if (password) {
            // Subsonic "enc:" prefix means hex-encoded password
            const plainPassword = password.startsWith("enc:")
                ? Buffer.from(password.slice(4), "hex").toString("utf8")
                : password;

            // An indexed hash lookup whose cost does not depend on the username, so it
            // adds no enumeration timing gap. Scoped to the claimed user. A key skips the
            // 2FA check below: it was minted from a 2FA-verified session.
            const keyUser = await findApiKeyUser(plainPassword);
            if (keyUser && keyUser.username === username) {
                req.user = keyUser;
                req.subsonicAuthMethod = "apiKey";
                next();
                return;
            }

            // Not a key for this user (wrong value, or a key that belongs
            // to someone else) -- fall through to the account password.
            const user = await prisma.user.findUnique({
                where: { username },
                select: { id: true, username: true, role: true, passwordHash: true, twoFactorEnabled: true },
            });

            // Subsonic reports failures inside HTTP 200 replies, so this is counted here, not from a status code.
            if (!subsonicGuesses.take(username)) {
                subsonicError(
                    req,
                    res,
                    SubsonicError.WRONG_CREDENTIALS,
                    "Too many wrong passwords. Try again in 15 minutes, or use an app key.",
                );
                return;
            }

            const valid = await bcrypt.compare(plainPassword, user?.passwordHash ?? NO_ACCOUNT_PASSWORD_HASH);

            if (!user || !valid) {
                subsonicError(req, res, SubsonicError.WRONG_CREDENTIALS, "Wrong username or password");
                return;
            }
            subsonicGuesses.giveBack(username);

            // Subsonic cannot ask for a second factor, so a 2FA account cannot log in
            // with its password here; it must use an API key. The message says so, since
            // OpenSubsonic has no dedicated error code for this.
            if (user.twoFactorEnabled) {
                subsonicError(
                    req,
                    res,
                    SubsonicError.WRONG_CREDENTIALS,
                    "2FA is on. Create an app key in Kima Settings and use it here instead of your password.",
                );
                return;
            }

            req.user = { id: user.id, username: user.username, role: user.role };
            req.subsonicAuthMethod = "password";
            next();
            return;
        }

        subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: p or apiKey");
    } catch (_err) {
        subsonicError(req, res, SubsonicError.GENERIC, "Authentication error");
    }
}
