import speakeasy from "speakeasy";

/**
 * A bcrypt hash at the cost real ones use (10) that no password matches: checking a name that does not exist against
 * it takes as long as checking a real account, so the answer's timing does not say which names exist.
 */
export const NO_ACCOUNT_PASSWORD_HASH = "$2b$10$invalidhashfortimingsafety.00000000000000000000";

/** Whether a two-factor code fits the base32 secret now, allowing two 30-second steps either side for clock drift. */
export function totpMatches(secret: string, token: string): boolean {
    return speakeasy.totp.verify({ secret, encoding: "base32", token, window: 2 });
}
