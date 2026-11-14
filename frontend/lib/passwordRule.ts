/**
 * What a new password must be, checked before the form is sent. The server holds the same rule and has the last
 * word (`backend/src/services/users/accounts.ts`): at least 6 characters, and at most 72 UTF-8 bytes, because the
 * hash reads no further than that and would silently ignore the rest.
 */

const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_BYTES = 72;

/** What is wrong with the password, in words for the person typing it, or null when it is fine. */
export function passwordProblem(password: string): string | null {
    if (password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
        return `Password must be at most ${MAX_PASSWORD_BYTES} characters (accented letters, other alphabets and emoji count as more than one)`;
    }
    return null;
}
