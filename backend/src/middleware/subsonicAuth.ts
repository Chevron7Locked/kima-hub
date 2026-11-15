import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { NO_ACCOUNT_PASSWORD_HASH } from "../services/users/credentials";
import { subsonicError, SubsonicError } from "../utils/subsonicResponse";
import { findApiKeyUser } from "../services/users/apiKeyStore";
import { passwordGuessSubject, subsonicGuesses } from "../services/users/guessLimits";
import { findUserByUsername, normalizeUsername } from "../services/users/accounts";
import { one } from "../utils/subsonicParams";

/**
 * Whether the typed name means the account that owns a key: the same answer the password path's lookup gives. A key
 * owner stored under the trimmed name costs no query; one stored with padding needs the lookup, to see that no other
 * account takes the name first.
 */
async function namesKeyOwner(given: string, keyOwner: { id: string; username: string }): Promise<boolean> {
    const typed = normalizeUsername(given);
    if (keyOwner.username === typed) return true;
    if (normalizeUsername(keyOwner.username) !== typed) return false;
    return (await findUserByUsername(given, { id: true }))?.id === keyOwner.id;
}

export async function subsonicAuth(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    // The name as sent, for finding an account stored with padding; compared by the trimmed name, and counted per account.
    const given = one(req, "u") ?? "";
    const username = normalizeUsername(given);
    const apiKey = one(req, "apiKey");
    const password = one(req, "p");
    const tokenMd5 = one(req, "t");

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
            if (!keyUser || !(await namesKeyOwner(given, keyUser))) {
                subsonicError(req, res, SubsonicError.WRONG_CREDENTIALS, "Wrong username or password");
                return;
            }

            req.user = keyUser;
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
            if (keyUser && (await namesKeyOwner(given, keyUser))) {
                req.user = keyUser;
                next();
                return;
            }

            // Not a key for this user (wrong value, or a key that belongs
            // to someone else) -- fall through to the account password.
            const user = await findUserByUsername(given, {
                id: true,
                username: true,
                role: true,
                passwordHash: true,
                twoFactorEnabled: true,
            });

            // Subsonic reports failures inside HTTP 200 replies, so this is counted here, not from a status code.
            const guessSubject = passwordGuessSubject(given, user);
            const guess = subsonicGuesses.take(guessSubject);
            if (!guess) {
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
            subsonicGuesses.giveBack(guess);

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
            next();
            return;
        }

        subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: p or apiKey");
    } catch (_err) {
        subsonicError(req, res, SubsonicError.GENERIC, "Authentication error");
    }
}
