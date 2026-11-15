import crypto from "crypto";
import speakeasy from "speakeasy";
import { prisma } from "../../utils/db";
import { decrypt, encrypt } from "../../utils/encryption";

/**
 * A bcrypt hash at the cost real ones use (10) that no password matches: checking a name that does not exist against
 * it takes as long as checking a real account, so the answer's timing does not say which names exist.
 */
export const NO_ACCOUNT_PASSWORD_HASH = "$2b$10$invalidhashfortimingsafety.00000000000000000000";

const TOTP_STEP_SECONDS = 30;

/**
 * The 30-second step a two-factor code belongs to, or null when it fits no step now. Two steps either side are allowed
 * for clock drift. Naming the step lets the caller spend it, so the code cannot be used twice (RFC 6238 section 5.2).
 */
export function totpStep(secret: string, token: string): number | null {
    // The step is read once, so the one the code is checked against is the one named.
    const now = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    const match = speakeasy.totp.verifyDelta({ secret, encoding: "base32", token, window: 2, counter: now });
    return match ? now + match.delta : null;
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
        const codes = decrypt(current).split(",");
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
