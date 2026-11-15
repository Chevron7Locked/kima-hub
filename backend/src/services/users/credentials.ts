import crypto from "crypto";
import speakeasy from "speakeasy";
import { prisma } from "../../utils/db";
import { decrypt, encrypt } from "../../utils/encryption";
import { logger } from "../../utils/logger";

/**
 * A bcrypt hash at the cost real ones use (10) that no password matches: checking a name that does not exist against
 * it takes as long as checking a real account, so the answer's timing does not say which names exist.
 */
export const NO_ACCOUNT_PASSWORD_HASH = "$2b$10$invalidhashfortimingsafety.00000000000000000000";

const TOTP_STEP_SECONDS = 30;

/**
 * The 30-second step a two-factor code belongs to, or null when it fits no step now. One step either side is allowed
 * for clock drift (RFC 6238 section 5.2). Naming the step lets the caller spend it, so the code cannot be used twice.
 */
export function totpStep(secret: string, token: string): number | null {
    // The step is read once, so the one the code is checked against is the one named.
    const now = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    const match = speakeasy.totp.verifyDelta({ secret, encoding: "base32", token, window: 1, counter: now });
    return match ? now + match.delta : null;
}

/**
 * The two-factor secret of an account that has it on, readable, or null when none is stored or the key cannot read it
 * (an unreadable credential). Either way the stored value is left as it is, and the reason is logged, so the caller
 * can refuse the request instead of treating the account as having no second factor.
 */
export function readTwoFactorSecret(userId: string, stored: string | null): string | null {
    if (!stored) {
        logger.warn(`[2FA] ${userId} has two-factor on but no secret stored; refusing`);
        return null;
    }
    try {
        return decrypt(stored);
    } catch (error) {
        logger.warn(`[2FA] ${userId} has a two-factor secret the current key cannot read; refusing, it is kept as stored:`, error);
        return null;
    }
}

/**
 * Spends a step for a person: true when it is newer than any they have used, false when it or a later one is spent
 * already. One conditional write, so two sign-ins sending one code together cannot both succeed.
 */
export async function spendTotpStep(userId: string, step: number): Promise<boolean> {
    const spent = await prisma.user.updateMany({
        where: { id: userId, twoFactorLastStep: { lt: step } },
        data: { twoFactorLastStep: step },
    });
    return spent.count === 1;
}

/**
 * A recovery code is sixteen hex characters (8 random bytes); lists made before that hold eight. An authenticator code is
 * six numerals, so the two are never mistaken.
 */
const RECOVERY_CODE = /^([A-F0-9]{8}|[A-F0-9]{16})$/i;

/**
 * A second-factor code as a person types or pastes it: spaces and dashes (a copied "1234-5678" or "123 456") and the
 * line break around it are dropped, and a recovery code is put in upper case. Whatever is left is checked as it stands.
 */
export function normalizeSecondFactor(typed: string): string {
    const bare = typed.replace(/[\s-]/g, "");
    return isRecoveryCodeShaped(bare) ? bare.toUpperCase() : bare;
}

/** Whether a code is shaped like a recovery code rather than an authenticator code. */
export function isRecoveryCodeShaped(token: string): boolean {
    return RECOVERY_CODE.test(token);
}

/** How long a secret from setup waits for a code that proves it. */
export const PENDING_SECRET_LIFETIME_MS = 10 * 60_000;

/**
 * The secret setup kept for a person, or null when none waits, it is older than ten minutes, or the key cannot read it.
 * A pending secret holds nothing worth keeping, so an unreadable one is the same as none: setup makes a new one.
 */
export function readPendingTwoFactorSecret(stored: string | null, madeAt: Date | null): string | null {
    if (!stored || !madeAt) return null;
    if (Date.now() - madeAt.getTime() > PENDING_SECRET_LIFETIME_MS) return null;
    try {
        return decrypt(stored);
    } catch {
        return null;
    }
}

/**
 * Logs that a person's recovery-code list cannot be read by the current key (an unreadable credential). A sign-in that
 * sends a code calls it once, so the cause shows in the log whatever kind of code was sent. Nothing is changed or refused.
 */
export function warnIfRecoveryListUnreadable(userId: string, stored: string | null): void {
    if (!stored) return;
    try {
        decrypt(stored);
    } catch (error) {
        logger.warn(`[2FA] ${userId} has a recovery-code list the current key cannot read; refusing its codes, it is kept as stored:`, error);
    }
}

/**
 * Spends the second factor a person sent: a recovery code (when it is shaped like one) or an authenticator code for
 * their secret. True when it was right and is now used up, so it cannot be used again. Sign-in, turning 2FA off and
 * new recovery codes all take it through here.
 */
export async function spendSecondFactor(
    user: { id: string; recoveryCodes: string | null },
    secret: string,
    token: string,
): Promise<boolean> {
    if (isRecoveryCodeShaped(token)) return spendRecoveryCode(user.id, user.recoveryCodes, token);
    const step = totpStep(secret, token);
    return step !== null && (await spendTotpStep(user.id, step));
}

/** Ten new recovery codes: the plain codes to show once, and the list to store (hashes, encrypted). */
export function newRecoveryCodes(): { codes: string[]; stored: string } {
    const codes: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 10; i++) {
        // Sixteen hex characters, stored only as a hash.
        const code = crypto.randomBytes(8).toString("hex").toUpperCase();
        codes.push(code);
        hashes.push(crypto.createHash("sha256").update(code).digest("hex"));
    }
    return { codes, stored: encrypt(hashes.join(",")) };
}

/**
 * Replaces a person's whole recovery list with ten new codes, only if the list stored is still `readList`: the one the
 * caller read after spending its own code. Returns the new codes to show once, or null when the list changed (or 2FA
 * was turned off) in between, so two requests cannot both be told their list is the one in force.
 */
export async function replaceRecoveryCodes(userId: string, readList: string | null): Promise<string[] | null> {
    const fresh = newRecoveryCodes();
    const written = await prisma.user.updateMany({
        where: { id: userId, twoFactorEnabled: true, twoFactorRecoveryCodes: readList },
        data: { twoFactorRecoveryCodes: fresh.stored },
    });
    return written.count === 1 ? fresh.codes : null;
}

/** The most tries to spend a code while other sign-ins keep changing the list: each lost try means another spent one of ten. */
const MAX_SPEND_TRIES = 10;

/**
 * Spends one recovery code of a person: true when it was in their list and is now gone. The write only lands if the
 * list is still the one the code was found in. When another sign-in changed the list first, it is read again and the
 * code looked for in it, so two honest sign-ins with different codes both succeed, while one code sent twice works once.
 */
export async function spendRecoveryCode(userId: string, encryptedCodes: string | null, code: string): Promise<boolean> {
    const hash = crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
    let current = encryptedCodes;
    for (let attempt = 0; attempt < MAX_SPEND_TRIES; attempt++) {
        if (!current) return false;
        let codes: string[];
        try {
            codes = decrypt(current).split(",");
        } catch {
            // An unreadable list is kept as it is, and no code is taken from it. A sign-in logs it (warnIfRecoveryListUnreadable).
            return false;
        }
        const index = codes.indexOf(hash);
        if (index === -1) return false;
        codes.splice(index, 1);

        const spent = await prisma.user.updateMany({
            where: { id: userId, twoFactorRecoveryCodes: current },
            data: { twoFactorRecoveryCodes: encrypt(codes.join(",")) },
        });
        if (spent.count === 1) return true;

        const fresh = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorRecoveryCodes: true } });
        current = fresh?.twoFactorRecoveryCodes ?? null;
    }
    return false;
}
