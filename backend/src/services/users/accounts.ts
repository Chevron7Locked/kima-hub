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
 * Anything else that goes wrong (the database is down) throws.
 */

/** A password is at least this many characters. The only place the rule lives. */
const MIN_PASSWORD_LENGTH = 6;
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
type UsernameTaken = { ok: false; reason: "username-taken" };
type Created = { ok: true; user: Account };

const isTooShort = (password: unknown) => typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH;
const passwordTooShort = (): PasswordTooShort => ({ ok: false, reason: "password-too-short", minimum: MIN_PASSWORD_LENGTH });
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
}): Promise<Created | UsernameTaken | PasswordTooShort> {
    if (isTooShort(input.password)) return passwordTooShort();
    const passwordHash = await hashPassword(input.password);
    try {
        const user = await prisma.$transaction((tx) =>
            insertAccount(tx, {
                username: input.username,
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
}): Promise<Created | UsernameTaken | PasswordTooShort | { ok: false; reason: "registration-closed" }> {
    if (isTooShort(input.password)) return passwordTooShort();
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
                username: input.username,
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
    | PasswordTooShort
    | { ok: false; reason: "not-found" | "wrong-password" }
> {
    if (isTooShort(input.newPassword)) return passwordTooShort();
    const stored = await prisma.user.findUnique({ where: { id: input.userId }, select: { passwordHash: true } });
    if (!stored) return { ok: false, reason: "not-found" };
    if (!(await bcrypt.compare(input.currentPassword, stored.passwordHash))) return { ok: false, reason: "wrong-password" };
    const user = await setPassword(input.userId, input.newPassword, stored.passwordHash);
    // Nothing matched: the password changed, or the account went, since it was read.
    return user ? { ok: true, user } : { ok: false, reason: "wrong-password" };
}

/**
 * The startup reset (`ADMIN_RESET_PASSWORD`): sets one admin's password and signs it out everywhere. A password
 * under the rule is refused with a log line and the admin keeps the one it has.
 */
export async function resetAdminPassword(password: string): Promise<"reset" | "password-too-short" | "no-admin"> {
    if (isTooShort(password)) {
        logger.warn(
            `[Password Reset] ADMIN_RESET_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters; the admin password was not changed.`,
        );
        return "password-too-short";
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
