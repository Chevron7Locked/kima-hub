/**
 * A second-factor code as the web takes it, in one place for sign-in and settings: an authenticator code (6 digits) or
 * a recovery code (16 hex characters; lists made before 1.13 hold 8). Spaces and dashes from a paste are dropped.
 */
export const RECOVERY_CODE_LENGTH = 16;
/** Recovery codes issued before 1.13 are this long. */
const LEGACY_RECOVERY_CODE_LENGTH = 8;
const AUTHENTICATOR_CODE_LENGTH = 6;

/** What a recovery-code field holds after typing or pasting: hex only, upper case, at most one code long. */
export function recoveryCodeInput(value: string): string {
    return value.replace(/[^0-9a-fA-F]/g, "").toUpperCase().slice(0, RECOVERY_CODE_LENGTH);
}

const FACTOR_PATTERN = new RegExp(
    `^(\\d{${AUTHENTICATOR_CODE_LENGTH}}|[A-F0-9]{${LEGACY_RECOVERY_CODE_LENGTH}}|[A-F0-9]{${RECOVERY_CODE_LENGTH}})$`,
);

/** Whether what a field holds is a whole second-factor code: six digits, or a recovery code of eight or sixteen characters. */
export function isFactor(value: string): boolean {
    return FACTOR_PATTERN.test(value);
}

/** The codes the server answers beside its text when a sign-in meets the second factor. The page reads these, never the words. */
export const SECOND_FACTOR_CODE = {
    required: "2FA_REQUIRED",
    invalid: "INVALID_2FA_TOKEN",
    invalidRecovery: "INVALID_RECOVERY_CODE",
} as const;

/** The machine code a failed sign-in carries in the body `api.request` keeps on its error; undefined when it has none. */
export function signInCode(err: unknown): string | undefined {
    const data = (err as { data?: { code?: unknown } } | null | undefined)?.data;
    return typeof data?.code === "string" ? data.code : undefined;
}

/** What a sign-in that needs a code throws: the server answers 200 with `requires2FA`, so there is no body to read a code from. */
export function secondFactorRequired(): Error {
    return Object.assign(new Error("2FA token required"), { data: { requires2FA: true, code: SECOND_FACTOR_CODE.required } });
}
