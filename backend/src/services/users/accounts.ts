import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { defaultUserSettingsFor } from "../../utils/userSettingsDefaults";
import { invalidateUserCache } from "../../middleware/auth";

/**
 * Accounts: the one place an account is made or a password is set, for the web, onboarding and the startup admin
 * reset. It holds the password rule, the hashing, the first admin and the sign-out of old sessions, so no caller
 * repeats them. Checking a password at sign-in is not here: that belongs to each sign-in surface and its guess limit.
 *
 * Every answer is a value, never a thrown "taken" or "too short": a caller maps the reasons to its own status codes.
 * The one thrown refusal is `LastAdminError`, from deleting an account: the refusal is decided inside the transaction
 * that would have deleted it, and the throw is what rolls that back. Anything else that goes wrong (the database is
 * down, a transaction conflict) throws as it came.
 */

/** A password is at least this many characters. The only place the rule lives. */
const MIN_PASSWORD_LENGTH = 6;
/**
 * A password is at most this many UTF-8 bytes: bcrypt reads only the first 72, so anything past that would be
 * silently ignored. Bytes, not characters: an accented letter is two, an emoji four.
 */
const MAX_PASSWORD_BYTES = 72;
/** A username is this many characters (counting a whole emoji as one), at the least and at the most. */
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 50;
const HASH_COST = 10;

/**
 * Held for the length of a sign-up transaction, so two people signing up together are counted one after the other:
 * only the one that finds no accounts becomes the admin.
 */
const SIGN_UP_LOCK_KEY = 7461100019;

export type AccountRole = "user" | "admin";

/** What a caller may know of an account: never the password hash. */
export interface Account {
    id: string;
    username: string;
    role: AccountRole;
    onboardingComplete: boolean;
    tokenVersion: number;
    createdAt: Date;
}

type PasswordTooShort = { ok: false; reason: "password-too-short"; minimum: number };
type PasswordTooLong = { ok: false; reason: "password-too-long"; maximum: number };
type UsernameInvalid = { ok: false; reason: "username-invalid"; minimum: number; maximum: number };
/** A password the rule refuses. */
export type PasswordRefusal = PasswordTooShort | PasswordTooLong;
/** An input the rules refuse: a caller shows `refusalMessage` of it. */
export type Refusal = PasswordRefusal | UsernameInvalid;
type UsernameTaken = { ok: false; reason: "username-taken" };
type Created = { ok: true; user: Account };

/** The password rule: null when the password is fine, else the refusal. */
function passwordRefusal(password: unknown): PasswordRefusal | null {
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
        return { ok: false, reason: "password-too-short", minimum: MIN_PASSWORD_LENGTH };
    }
    if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
        return { ok: false, reason: "password-too-long", maximum: MAX_PASSWORD_BYTES };
    }
    return null;
}

/**
 * A username as it is stored and looked up: without the spaces around it. Sign-up and account creation store it so,
 * and both sign-in surfaces look it up so, which is why a name typed with a stray space still signs in. Accounts
 * stored with padding before this rule are not rewritten.
 */
export const normalizeUsername = (username: string): string => username.trim();

/**
 * The account a person means by a typed name: the trimmed name first, then the name exactly as given, so an account
 * stored with padding before the trim rule still signs in. The trimmed account wins when both exist. Every sign-in
 * and username lookup goes through here. Returns only the fields in `select`, or null.
 */
export async function findUserByUsername<S extends Prisma.UserSelect>(
    given: string,
    select: S,
): Promise<Prisma.UserGetPayload<{ select: S }> | null> {
    const trimmed = normalizeUsername(given);
    const found = await prisma.user.findUnique({ where: { username: trimmed }, select });
    if (found || given === trimmed) return found;
    return prisma.user.findUnique({ where: { username: given }, select });
}

/** The username rule, applied to the name as it will be stored: null when the name is fine, else the refusal. */
function usernameRefusal(username: unknown): UsernameInvalid | null {
    const length = typeof username === "string" ? Array.from(normalizeUsername(username)).length : 0;
    if (length < MIN_USERNAME_LENGTH || length > MAX_USERNAME_LENGTH) {
        return { ok: false, reason: "username-invalid", minimum: MIN_USERNAME_LENGTH, maximum: MAX_USERNAME_LENGTH };
    }
    return null;
}

/** The username and the password together, as a new account is given them. */
const signUpRefusal = (input: { username: unknown; password: unknown }): Refusal | null =>
    usernameRefusal(input.username) ?? passwordRefusal(input.password);

/** What to tell a person whose input was refused; `subject` names the password ("New password") where it differs. */
export function refusalMessage(refusal: Refusal, subject = "Password"): string {
    switch (refusal.reason) {
        case "password-too-short":
            return `${subject} must be at least ${refusal.minimum} characters`;
        case "password-too-long":
            return `${subject} must be at most ${refusal.maximum} characters (accented letters, other alphabets and emoji count as more than one)`;
        case "username-invalid":
            return `Username must be ${refusal.minimum} to ${refusal.maximum} characters`;
    }
}
const hashPassword = (password: string) => bcrypt.hash(password, HASH_COST);

const ACCOUNT_FIELDS = { id: true, username: true, role: true, onboardingComplete: true, tokenVersion: true, createdAt: true } as const;

/** The user row and its settings in the one transaction, so neither is ever left without the other. */
async function insertAccount(
    tx: Prisma.TransactionClient,
    input: { username: string; passwordHash: string; role: AccountRole; onboardingComplete: boolean },
): Promise<Account> {
    const user = await tx.user.create({ data: input, select: ACCOUNT_FIELDS });
    await tx.userSettings.create({ data: defaultUserSettingsFor(user.id) });
    return user as Account;
}

const isUniqueClash = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** A new account with the role it is given, for an admin creating one. */
export async function createAccount(input: {
    username: string;
    password: string;
    role: AccountRole;
    onboardingComplete: boolean;
}): Promise<Created | UsernameTaken | Refusal> {
    const refused = signUpRefusal(input);
    if (refused) return refused;
    const passwordHash = await hashPassword(input.password);
    try {
        const user = await prisma.$transaction((tx) =>
            insertAccount(tx, {
                username: normalizeUsername(input.username),
                passwordHash,
                role: input.role,
                onboardingComplete: input.onboardingComplete,
            }),
        );
        return { ok: true, user };
    } catch (error) {
        if (isUniqueClash(error)) return { ok: false, reason: "username-taken" };
        throw error;
    }
}

/**
 * Someone signing themselves up. The first account ever becomes the admin, whether or not sign-up is open; later ones
 * are plain users and only while `registrationOpen`. Sign-ups are counted one after the other, so two arriving
 * together cannot both find the table empty.
 */
export async function signUp(input: {
    username: string;
    password: string;
    registrationOpen: boolean;
}): Promise<Created | UsernameTaken | Refusal | { ok: false; reason: "registration-closed" }> {
    const refused = signUpRefusal(input);
    if (refused) return refused;
    // Refuse a closed sign-up before the costly hash, so a stranger cannot make the server hash for nothing. The check
    // inside the transaction below is the one that counts.
    if (!input.registrationOpen && (await prisma.user.count()) > 0) return { ok: false, reason: "registration-closed" };
    const passwordHash = await hashPassword(input.password);
    try {
        return await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${SIGN_UP_LOCK_KEY})`);
            const isFirst = (await tx.user.count()) === 0;
            if (!isFirst && !input.registrationOpen) return { ok: false, reason: "registration-closed" } as const;
            const user = await insertAccount(tx, {
                username: normalizeUsername(input.username),
                passwordHash,
                role: isFirst ? "admin" : "user",
                onboardingComplete: false,
            });
            return { ok: true, user } as const;
        });
    } catch (error) {
        if (isUniqueClash(error)) return { ok: false, reason: "username-taken" };
        throw error;
    }
}

/**
 * Sets the password and signs out every session issued before: a new tokenVersion revokes every token. With
 * `ifHashIs` the write happens only while the stored hash is still that one, so two changes made together cannot both
 * succeed from the same current password; `null` answers that it did not.
 */
async function setPassword(userId: string, password: string, ifHashIs?: string) {
    const passwordHash = await hashPassword(password);
    const { count } = await prisma.user.updateMany({
        where: ifHashIs === undefined ? { id: userId } : { id: userId, passwordHash: ifHashIs },
        data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    if (count === 0) return null;
    // The auth layer caches the user row, and tokenVersion is what revokes issued tokens: without this the old
    // tokens keep working until the cache expires.
    invalidateUserCache(userId);
    return prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, role: true, tokenVersion: true },
    });
}

/**
 * A signed-in person changing their own password, which they must give the current one for. Every other device is
 * signed out; the caller makes fresh tokens for this one from the `user` it gets back.
 */
export async function changePassword(input: { userId: string; currentPassword: string; newPassword: string }): Promise<
    | { ok: true; user: { id: string; username: string; role: string; tokenVersion: number } }
    | PasswordRefusal
    | { ok: false; reason: "not-found" | "wrong-password" }
> {
    const refused = passwordRefusal(input.newPassword);
    if (refused) return refused;
    const stored = await prisma.user.findUnique({ where: { id: input.userId }, select: { passwordHash: true } });
    if (!stored) return { ok: false, reason: "not-found" };
    if (!(await bcrypt.compare(input.currentPassword, stored.passwordHash))) return { ok: false, reason: "wrong-password" };
    const user = await setPassword(input.userId, input.newPassword, stored.passwordHash);
    // Nothing matched: the password changed, or the account went, since it was read.
    return user ? { ok: true, user } : { ok: false, reason: "wrong-password" };
}

/** The only admin cannot be deleted: the instance would have no one to administer it. */
export class LastAdminError extends Error {
    constructor() {
        super("Cannot delete the only administrator account");
        this.name = "LastAdminError";
    }
}

/**
 * Deletes an account; every row that belongs to it goes with it. An admin is refused (`LastAdminError`) when it is the
 * only one: the count and the delete run in one Serializable transaction, so two admins deleting themselves together
 * cannot both see another admin and leave none (the loser throws a transaction conflict, which is safe to retry). The
 * cached user is dropped after the commit, so the account's tokens stop working now. An account already gone is
 * nothing to delete.
 */
export async function deleteAccount(userId: string): Promise<void> {
    await prisma.$transaction(
        async (tx) => {
            const account = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
            if (!account) return;
            if (account.role === "admin" && (await tx.user.count({ where: { role: "admin" } })) <= 1) {
                throw new LastAdminError();
            }
            // Every User relation cascades on delete.
            await tx.user.delete({ where: { id: userId } });
        },
        { isolationLevel: "Serializable" },
    );
    invalidateUserCache(userId);
}

/**
 * The startup reset (`ADMIN_RESET_PASSWORD`): sets one admin's password and signs it out everywhere. A password
 * outside the rule is refused with a log line and the admin keeps the one it has.
 */
export async function resetAdminPassword(password: string): Promise<"reset" | PasswordRefusal["reason"] | "no-admin"> {
    const refused = passwordRefusal(password);
    if (refused) {
        logger.error(
            `[Password Reset] ADMIN_RESET_PASSWORD refused: ${refusalMessage(refused, "the password")}. The admin password was not changed.`,
        );
        return refused.reason;
    }
    const admin = await prisma.user.findFirst({ where: { role: "admin" }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (!admin) {
        logger.warn("[Password Reset] No admin user found");
        return "no-admin";
    }
    await setPassword(admin.id, password);
    logger.warn(
        "[Password Reset] Admin password has been reset via ADMIN_RESET_PASSWORD env var. Remove this env var and restart.",
    );
    return "reset";
}
