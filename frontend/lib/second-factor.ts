/**
 * A second-factor code as the web takes it, in one place for sign-in and settings: an authenticator code (6 digits) or
 * a recovery code (16 hex characters; lists made before 1.13 hold 8). Spaces and dashes from a paste are dropped.
 */
export const RECOVERY_CODE_LENGTH = 16;

/** What a recovery-code field holds after typing or pasting: hex only, upper case, at most one code long. */
export function recoveryCodeInput(value: string): string {
    return value.replace(/[^0-9a-fA-F]/g, "").toUpperCase().slice(0, RECOVERY_CODE_LENGTH);
}

/** What a field that takes either kind of code holds after typing or pasting. */
export const factorInput = recoveryCodeInput;

/** Whether what a field holds is a whole second-factor code: six digits, or a recovery code of eight or sixteen characters. */
export function isFactor(value: string): boolean {
    return /^\d{6}$/.test(value) || /^([A-F0-9]{8}|[A-F0-9]{16})$/.test(value);
}
