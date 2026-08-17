import { Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../utils/db";
import { subsonicError, SubsonicError } from "../utils/subsonicResponse";
import { hashApiKey } from "../services/users/apiKeyStore";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /**
             * Set by subsonicAuth -- which of its credential forms authenticated
             * this request. `user` is set identically regardless of which one
             * succeeded; this is for the routes that need to know WHICH one, not
             * just that one did (changePassword.view refuses a self-change made
             * with an API key -- an app credential that can silently take over
             * the login password isn't a lesser door, it's the same door --
             * while the same self-change made with the account password works).
             */
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
        // MD5 token auth (t=md5(secret+salt)&s=salt) is a challenge-response
        // scheme: verifying it means reproducing the client's computation,
        // which requires the server to hold the secret itself, not a one-way
        // digest of it. That was true even before this file's own comment
        // above (still accurate) explains why an API key had to stand in for
        // the account password here in the first place -- `passwordHash` is
        // bcrypt, salted, unrecoverable, so it could never answer this
        // challenge either. Now that the API key is ALSO stored as a
        // one-way SHA-256 digest (`apiKeyStore.ts`'s `hashApiKey` --
        // ApiKey.keyHash never holds anything reversible, deliberately, so a
        // DB or backup leak no longer hands over live credentials), there is
        // no secret left anywhere on this server that could reproduce
        // md5(secret+salt). No HASHING scheme recovers that -- but hashing was
        // a choice, not the only one, and this is the price it carries. Say so
        // plainly here, because the alternative is not hypothetical and it is
        // sitting in this repo.
        //
        // The alternative: store the key ENCRYPTED at rest rather than hashed
        // -- reversible, under a key held outside the database. utils/encryption.ts
        // already provides exactly that (XChaCha20-Poly1305 under
        // SETTINGS_ENCRYPTION_KEY) and already protects the stored service
        // credentials and the 2FA secrets. Encrypted, the server could still
        // recover the key to answer the challenge, so `t=`/`s=` would keep
        // working, and a stolen dump would still be useless WITHOUT the
        // environment key.
        //
        // Hashing was chosen anyway, deliberately. Against the threat actually
        // named -- a database read or a leaked backup -- it is strictly
        // stronger, because it does not depend on the environment key having
        // stayed out of that same backup, which is exactly the assumption that
        // fails when someone tars up a whole deployment directory. The cost is
        // that token auth dies and a client moves to `apiKey=` or the password
        // field. That is the trade. It is not a law of physics, and nobody
        // reading this later should conclude there was never another option.
        // `TOKEN_AUTH_NOT_SUPPORTED`
        // is a real Subsonic protocol error code (41), so a client sending
        // `t=`/`s=` gets a clear, spec-defined "this method isn't available"
        // rather than a "wrong password" that would send a legitimate user
        // down the wrong debugging path. The OpenSubsonic `apiKey=` param
        // below, and the legacy `p=` password path further down, are
        // unaffected -- both are plain equality checks (against a computed
        // digest, or against bcrypt respectively), never challenge-response,
        // so neither ever needed the plaintext key to exist.
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
            const keyRecord = await prisma.apiKey.findUnique({
                where: { keyHash: hashApiKey(apiKey) },
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
            // A provisioned app credential, not the account password -- see
            // the 2FA note on the password branch below for why this
            // distinction has to survive past this middleware, not just gate
            // entry here.
            req.subsonicAuthMethod = "apiKey";
            next();
            return;
        }

        // Legacy p= password field -- but an API key works here too, tried
        // FIRST. The README has told every native client (Amperfy,
        // Symfonium, DSub) to "paste your API token into the password
        // field" since before this file had an `apiKey=` param, because
        // that's the only way those clients' plain username+password login
        // screens can carry a token at all -- most of them never send
        // `apiKey=` themselves, they just resend whatever the user typed
        // here. Removing MD5 token auth (above) without this would have
        // silently broken every one of them: `apiKey=` alone only helps
        // clients that specifically speak OpenSubsonic.
        if (password) {
            // Subsonic "enc:" prefix means hex-encoded password
            const plainPassword = password.startsWith("enc:")
                ? Buffer.from(password.slice(4), "hex").toString("utf8")
                : password;

            // A cheap indexed hash lookup, tried before the bcrypt path
            // below -- SHA-256 + an index hit is far cheaper than bcrypt,
            // and a key is the credential this whole file steers people
            // toward. Scoped to the claimed username the same way `apiKey=`
            // above already is (`keyRecord.user.username !== username` ->
            // WRONG_CREDENTIALS there), so a key can't authenticate as
            // anyone but the account it was issued to.
            //
            // This lookup's cost does not depend on whether `username` is a
            // real account -- it queries ApiKey.keyHash alone, nothing about
            // User -- so trying it first cannot reopen the username-
            // enumeration timing gap the bcrypt-against-a-dummy-hash branch
            // below exists to close; it only adds a constant, input-
            // independent index probe ahead of that unchanged path.
            //
            // A match here NEVER touches passwordHash or `twoFactorEnabled`
            // at all, on purpose -- it's the identical credential class
            // `apiKey=` already is, just arriving in a different query
            // parameter, and that branch never touches them either. The 2FA
            // refusal further down exists specifically because the ACCOUNT
            // PASSWORD needs a second factor Subsonic can't ask for; an app
            // key the user minted from an already-2FA-verified web session
            // is not that secret, and must not be blocked by a check that
            // was never about keys.
            const keyRecord = await prisma.apiKey.findUnique({
                where: { keyHash: hashApiKey(plainPassword) },
                include: {
                    user: { select: { id: true, username: true, role: true } },
                },
            });
            if (keyRecord && keyRecord.user.username === username) {
                prisma.apiKey
                    .update({ where: { id: keyRecord.id }, data: { lastUsed: new Date() } })
                    .catch(() => {});

                req.user = keyRecord.user;
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

            // The account password is exactly what 2FA exists to make
            // insufficient on its own -- `POST /auth/login` already refuses
            // to issue a session from the password alone when
            // `twoFactorEnabled` is set, prompting for a TOTP/recovery code
            // instead. This path used to skip that entirely: a Subsonic
            // client sending only `p=` got a full session on the same
            // bcrypt check, no code ever asked for, because the protocol has
            // no concept of a second factor to ask a native client for.
            // Native clients (Amperfy, Symfonium, DSub) can't prompt for a
            // TOTP code, so "ask for it here too" isn't an option -- the fix
            // is to refuse this credential class for a 2FA account entirely,
            // the same way `apiKey=` above already succeeds without ever
            // touching `passwordHash` or 2FA: an API key is a DIFFERENT
            // credential the user explicitly provisions from an already-
            // 2FA-verified session (`POST /api/api-keys`, behind
            // `requireAuth`), not the same secret checked on a second door.
            // WRONG_CREDENTIALS (40) rather than a dedicated code: OpenSubsonic
            // has no "2FA required" error code, and native clients generally
            // just surface the message text regardless of the numeric code,
            // so the code matters less than the words -- which is why this
            // message, unlike the "Wrong username or password" ones above,
            // spells out exactly what to do next rather than staying generic.
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
