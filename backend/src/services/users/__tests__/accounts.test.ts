/**
 * The account module: the one place an account is created or its password set. Real database. Each worker has its own
 * database and files in it run one at a time, so a test here may empty the accounts to look at the first one.
 */

jest.mock("../../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import bcrypt from "bcrypt";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import * as settingsDefaults from "../../../utils/userSettingsDefaults";
import { clearUserCache, generateToken, signedInUser } from "../../../middleware/auth";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import {
    changePassword,
    createAccount,
    deleteAccount,
    findUserByUsername,
    LastAdminError,
    normalizeUsername,
    refusalMessage,
    type Refusal,
    resetAdminPassword,
    signUp,
} from "../accounts";
import { isTransactionConflict } from "../../../utils/dbConflict";

jest.setTimeout(60_000);

const hash = (password: string) => bcrypt.hash(password, 4);
const matches = async (userId: string, password: string) =>
    bcrypt.compare(password, (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash);

async function seedUser(username: string, extra: Record<string, unknown> = {}) {
    return prisma.user.create({ data: { username, passwordHash: await hash("original-pass"), ...extra } });
}

const plain = (username: string, password = "secret1") =>
    createAccount({ username, password, role: "user", onboardingComplete: true });

beforeEach(async () => {
    await prisma.user.deleteMany();
    clearUserCache();
    jest.clearAllMocks();
});

afterAll(async () => {
    await prisma.user.deleteMany();
    await closeEngineConnections();
});

describe("createAccount", () => {
    it("makes the user and its settings together", async () => {
        const made = await plain("alice");

        expect(made.ok).toBe(true);
        if (!made.ok) return;
        expect(made.user).toMatchObject({ username: "alice", role: "user", onboardingComplete: true });
        expect(made.user).not.toHaveProperty("passwordHash");
        expect(await matches(made.user.id, "secret1")).toBe(true);
        expect(await prisma.userSettings.findUnique({ where: { userId: made.user.id } })).toMatchObject({
            playbackQuality: "original",
            shareLiveListening: true,
        });
    });

    it("keeps the role it is given", async () => {
        const made = await createAccount({ username: "boss", password: "secret1", role: "admin", onboardingComplete: true });
        expect(made.ok && made.user.role).toBe("admin");
    });

    it.each(["", "12345", "short"])("refuses the password %j as too short and creates nothing", async (password) => {
        expect(await plain("alice", password)).toEqual({ ok: false, reason: "password-too-short", minimum: 6 });
        expect(await prisma.user.count()).toBe(0);
    });

    it("takes a password of exactly 6 characters", async () => {
        expect((await plain("alice", "123456")).ok).toBe(true);
    });

    it("refuses a password that is not text", async () => {
        expect(await plain("alice", 123456789 as unknown as string)).toMatchObject({ ok: false, reason: "password-too-short" });
    });

    it("answers username taken for a name already used", async () => {
        await seedUser("alice");

        expect(await plain("alice")).toEqual({ ok: false, reason: "username-taken" });
        expect(await prisma.user.count()).toBe(1);
    });

    it("answers username taken when a stored name trims to the new one, on create and on sign-up", async () => {
        await seedUser(" alice ");

        expect(await plain("alice")).toEqual({ ok: false, reason: "username-taken" });
        expect(await plain("  alice\t")).toEqual({ ok: false, reason: "username-taken" });
        expect(await signUp({ username: "alice", password: "secret1", registrationOpen: true })).toEqual({
            ok: false,
            reason: "username-taken",
        });
        expect(await prisma.user.count()).toBe(1);
    });

    it("answers username taken, not an error, when accounts race for one name", async () => {
        const made = await Promise.all([1, 2, 3].map(() => plain("racer")));

        expect(made.filter((m) => m.ok)).toHaveLength(1);
        expect(made.filter((m) => !m.ok)).toEqual([
            { ok: false, reason: "username-taken" },
            { ok: false, reason: "username-taken" },
        ]);
        expect(await prisma.user.count({ where: { username: "racer" } })).toBe(1);
    });

    it("leaves no account behind when its settings cannot be written", async () => {
        const broken = jest
            .spyOn(settingsDefaults, "defaultUserSettingsFor")
            .mockImplementationOnce((userId) => ({ userId, playbackQuality: 5 }) as never);
        try {
            await expect(plain("halfway")).rejects.toThrow();
        } finally {
            broken.mockRestore();
        }

        expect(await prisma.user.count({ where: { username: "halfway" } })).toBe(0);
        // A retry works: the name is not stuck as taken.
        expect((await plain("halfway")).ok).toBe(true);
    });
});

// bcrypt reads only the first 72 bytes, so a longer password would be silently cut. The limit is in bytes, and
// the answers say it in characters.
const TOO_LONG: Refusal = { ok: false, reason: "password-too-long", maximum: 72 };
const bytes72 = "a".repeat(72);
const bytes73 = "a".repeat(73);
const accents36 = "é".repeat(36); // 72 bytes
const accents37 = "é".repeat(37); // 74 bytes, but only 37 characters

describe("the password's longest length", () => {
    it("takes 72 bytes and refuses 73, creating nothing", async () => {
        expect((await plain("alice", bytes72)).ok).toBe(true);
        expect(await plain("bob", bytes73)).toEqual(TOO_LONG);
        expect(await prisma.user.count({ where: { username: "bob" } })).toBe(0);
    });

    it("counts bytes, not characters: 36 accented letters pass, 37 do not", async () => {
        expect((await plain("alice", accents36)).ok).toBe(true);
        expect(await plain("bob", accents37)).toEqual(TOO_LONG);
    });

    it("counts an emoji as its four bytes", async () => {
        expect((await plain("alice", "😀".repeat(18))).ok).toBe(true);
        expect(await plain("bob", "😀".repeat(19))).toEqual(TOO_LONG);
    });

    it("refuses it on sign-up before anything else, creating nothing", async () => {
        expect(await signUp({ username: "first", password: bytes73, registrationOpen: false })).toEqual(TOO_LONG);
        expect(await prisma.user.count()).toBe(0);
    });

    it("refuses it on a password change and keeps the old password", async () => {
        const user = await seedUser("alice");
        expect(await changePassword({ userId: user.id, currentPassword: "original-pass", newPassword: bytes73 })).toEqual(TOO_LONG);
        expect(await matches(user.id, "original-pass")).toBe(true);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(0);
    });

    it("refuses it in the startup reset, with a log line, and keeps the admin's password", async () => {
        const admin = await seedUser("root", { role: "admin" });
        expect(await resetAdminPassword(bytes73)).toBe("password-too-long");
        expect(await matches(admin.id, "original-pass")).toBe(true);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringMatching(/ADMIN_RESET_PASSWORD.*at most 72.*not changed/),
        );
    });

    it("keeps every character of a 72-byte password: the stored hash matches it whole", async () => {
        const made = await plain("alice", accents36);
        expect(made.ok && (await matches(made.user.id, accents36))).toBe(true);
        expect(made.ok && (await matches(made.user.id, accents36.slice(0, -1)))).toBe(false);
    });

    it("says the limit in characters a person can follow", () => {
        expect(refusalMessage(TOO_LONG)).toBe(
            "Password must be at most 72 characters (accented letters, other alphabets and emoji count as more than one)",
        );
        expect(refusalMessage({ ok: false, reason: "password-too-short", minimum: 6 }, "New password")).toBe(
            "New password must be at least 6 characters",
        );
    });
});

describe("the username rule", () => {
    const BAD: Refusal = { ok: false, reason: "username-invalid", minimum: 3, maximum: 50 };

    it.each([["abc"], ["a".repeat(50)], ["ü".repeat(50)]])("takes %j on create", async (name) => {
        expect((await plain(name)).ok).toBe(true);
    });

    it.each([[""], ["ab"], ["a".repeat(51)], ["😀".repeat(51)]])("refuses %j on create, creating nothing", async (name) => {
        expect(await plain(name)).toEqual(BAD);
        expect(await prisma.user.count()).toBe(0);
    });

    it("applies the same rule on sign-up, before the closed check", async () => {
        expect((await signUp({ username: "abc", password: "secret1", registrationOpen: true })).ok).toBe(true);
        expect(await signUp({ username: "ab", password: "secret1", registrationOpen: false })).toEqual(BAD);
        expect(await signUp({ username: "a".repeat(51), password: "secret1", registrationOpen: true })).toEqual(BAD);
        expect(await prisma.user.count()).toBe(1);
    });

    it("refuses a username that is not text", async () => {
        expect(await createAccount({ username: 5 as never, password: "secret1", role: "user", onboardingComplete: true })).toEqual(BAD);
    });

    it("trims the name on create, so the stored name has no padding", async () => {
        const made = await plain("  alice\t ");
        expect(made.ok && made.user.username).toBe("alice");
        expect(await prisma.user.findUnique({ where: { username: "alice" } })).not.toBeNull();
    });

    it("trims the name on sign-up, so a padded and a plain name are one name", async () => {
        const first = await signUp({ username: " bob ", password: "secret1", registrationOpen: true });
        expect(first.ok && first.user.username).toBe("bob");
        expect(await signUp({ username: "bob", password: "secret1", registrationOpen: true })).toEqual({
            ok: false,
            reason: "username-taken",
        });
    });

    it.each([["   "], ["\t\n "], ["\u00a0\u00a0\u00a0"], ["  ab  "], [`  ${"a".repeat(51)}  `]])(
        "refuses %j: a blank, or short or long once trimmed",
        async (name) => {
            expect(await plain(name)).toEqual(BAD);
            expect(await signUp({ username: name, password: "secret1", registrationOpen: true })).toEqual(BAD);
            expect(await prisma.user.count()).toBe(0);
        },
    );

    it("measures the length after trimming: 50 characters inside padding pass", async () => {
        expect((await plain(`  ${"a".repeat(50)}  `)).ok).toBe(true);
    });

    it("gives sign-in the same trim: normalizeUsername", () => {
        expect(normalizeUsername("  alice \n")).toBe("alice");
        expect(normalizeUsername("alice")).toBe("alice");
        expect(normalizeUsername("   ")).toBe("");
    });

    it("says the rule in plain words", () => {
        expect(refusalMessage(BAD)).toBe("Username must be 3 to 50 characters");
    });
});

describe("signUp", () => {
    it("makes the first account an admin even while sign-up is closed", async () => {
        const made = await signUp({ username: "first", password: "secret1", registrationOpen: false });

        expect(made.ok).toBe(true);
        if (!made.ok) return;
        expect(made.user).toMatchObject({ username: "first", role: "admin", onboardingComplete: false });
        expect(await prisma.userSettings.count({ where: { userId: made.user.id } })).toBe(1);
    });

    it("makes later accounts plain users, and refuses them while sign-up is closed", async () => {
        await signUp({ username: "first", password: "secret1", registrationOpen: false });

        expect(await signUp({ username: "second", password: "secret1", registrationOpen: false })).toEqual({
            ok: false,
            reason: "registration-closed",
        });
        const made = await signUp({ username: "second", password: "secret1", registrationOpen: true });
        expect(made.ok && made.user.role).toBe("user");
        expect(await prisma.user.count()).toBe(2);
    });

    it("gives exactly one admin when many first sign-ups arrive together", async () => {
        const made = await Promise.all(
            Array.from({ length: 6 }, (_, i) => signUp({ username: `racer-${i}`, password: "secret1", registrationOpen: false })),
        );

        expect(made.filter((m) => m.ok)).toHaveLength(1);
        expect(made.filter((m) => !m.ok).every((m) => !m.ok && m.reason === "registration-closed")).toBe(true);
        expect(await prisma.user.count({ where: { role: "admin" } })).toBe(1);
        expect(await prisma.user.count()).toBe(1);
    });

    it("gives exactly one admin and no error when first sign-ups arrive together with sign-up open", async () => {
        const made = await Promise.all(
            Array.from({ length: 6 }, (_, i) => signUp({ username: `racer-${i}`, password: "secret1", registrationOpen: true })),
        );

        expect(made.every((m) => m.ok)).toBe(true);
        expect(await prisma.user.count({ where: { role: "admin" } })).toBe(1);
        expect(await prisma.user.count()).toBe(6);
    });

    it("gives one account and username taken when sign-ups use one name", async () => {
        await seedUser("existing", { role: "admin" });
        const made = await Promise.all(
            Array.from({ length: 4 }, () => signUp({ username: "samename", password: "secret1", registrationOpen: true })),
        );

        expect(made.filter((m) => m.ok)).toHaveLength(1);
        expect(made.filter((m) => !m.ok).every((m) => !m.ok && m.reason === "username-taken")).toBe(true);
        expect(await prisma.user.count({ where: { username: "samename" } })).toBe(1);
    });

    it("refuses a closed sign-up without hashing the password", async () => {
        await seedUser("existing", { role: "admin" });
        const hashing = jest.spyOn(bcrypt, "hash");
        try {
            expect(await signUp({ username: "late", password: "secret1", registrationOpen: false })).toEqual({
                ok: false,
                reason: "registration-closed",
            });
            expect(hashing).not.toHaveBeenCalled();
        } finally {
            hashing.mockRestore();
        }
    });

    it("refuses a short password before anything else, creating nothing", async () => {
        expect(await signUp({ username: "first", password: "12345", registrationOpen: false })).toMatchObject({
            ok: false,
            reason: "password-too-short",
        });
        expect(await prisma.user.count()).toBe(0);
    });
});

describe("changePassword", () => {
    it("sets the new password and answers the claims for the fresh tokens, one version on", async () => {
        const user = await seedUser("alice", { tokenVersion: 4 });

        const changed = await changePassword({ userId: user.id, currentPassword: "original-pass", newPassword: "brand-new-1" });

        expect(changed.ok).toBe(true);
        if (!changed.ok) return;
        expect(changed.user).toEqual({ id: user.id, username: "alice", role: "user", tokenVersion: 5 });
        expect(await matches(user.id, "brand-new-1")).toBe(true);
    });

    it("drops the cached user so an old token stops working at once", async () => {
        const user = await seedUser("alice", { tokenVersion: 1 });
        const oldToken = generateToken({ id: user.id, username: "alice", role: "user", tokenVersion: 1 });
        const passesAuth = async () =>
            (await signedInUser({ headers: { authorization: `Bearer ${oldToken}` }, query: {}, path: "/x" } as any)) !== null;
        expect(await passesAuth()).toBe(true);

        await changePassword({ userId: user.id, currentPassword: "original-pass", newPassword: "brand-new-1" });

        expect(await passesAuth()).toBe(false);
    });

    it("refuses a wrong current password and changes nothing", async () => {
        const user = await seedUser("alice");

        expect(await changePassword({ userId: user.id, currentPassword: "nope-nope", newPassword: "brand-new-1" })).toEqual({
            ok: false,
            reason: "wrong-password",
        });
        expect(await matches(user.id, "original-pass")).toBe(true);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(0);
    });

    it("refuses a new password under 6 characters and changes nothing", async () => {
        const user = await seedUser("alice");

        expect(await changePassword({ userId: user.id, currentPassword: "original-pass", newPassword: "12345" })).toEqual({
            ok: false,
            reason: "password-too-short",
            minimum: 6,
        });
        expect(await matches(user.id, "original-pass")).toBe(true);
    });

    it("lets only one of two changes made together win, the other is told the password is wrong", async () => {
        const user = await seedUser("alice");

        const changes = await Promise.all(
            ["first-new-1", "second-new-2"].map((newPassword) =>
                changePassword({ userId: user.id, currentPassword: "original-pass", newPassword }),
            ),
        );

        expect(changes.filter((c) => c.ok)).toHaveLength(1);
        expect(changes.find((c) => !c.ok)).toEqual({ ok: false, reason: "wrong-password" });
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).tokenVersion).toBe(1);
    });

    it("answers not found for an account that is gone", async () => {
        expect(await changePassword({ userId: "nobody", currentPassword: "x", newPassword: "brand-new-1" })).toEqual({
            ok: false,
            reason: "not-found",
        });
    });
});

describe("resetAdminPassword (the startup reset)", () => {
    it("sets the admin's password and signs every session out", async () => {
        const admin = await seedUser("root", { role: "admin", tokenVersion: 2 });
        await seedUser("listener");

        expect(await resetAdminPassword("rescue-pass")).toBe("reset");

        expect(await matches(admin.id, "rescue-pass")).toBe(true);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).tokenVersion).toBe(3);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ADMIN_RESET_PASSWORD"));
    });

    it("resets the oldest admin when there are several", async () => {
        const oldest = await seedUser("root", { role: "admin", createdAt: new Date("2020-01-01") });
        const newer = await seedUser("second", { role: "admin", createdAt: new Date("2024-01-01") });

        await resetAdminPassword("rescue-pass");

        expect(await matches(oldest.id, "rescue-pass")).toBe(true);
        expect(await matches(newer.id, "original-pass")).toBe(true);
    });

    it("refuses a password under 6 characters with a log line, leaving the admin password as it was", async () => {
        const admin = await seedUser("root", { role: "admin" });

        expect(await resetAdminPassword("12345")).toBe("password-too-short");

        expect(await matches(admin.id, "original-pass")).toBe(true);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).tokenVersion).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringMatching(/ADMIN_RESET_PASSWORD.*at least 6.*not changed/),
        );
    });

    it("says so when there is no admin", async () => {
        await seedUser("listener");

        expect(await resetAdminPassword("rescue-pass")).toBe("no-admin");
        expect(logger.warn).toHaveBeenCalled();
    });
});

describe("findUserByUsername (a name as a person typed it)", () => {
    it("finds an account by the trimmed name", async () => {
        const bob = await seedUser("bob");
        expect((await findUserByUsername("  bob\t", { id: true }))?.id).toBe(bob.id);
    });

    it("finds an account stored with padding by the name exactly as given", async () => {
        const padded = await seedUser(" bob");
        expect((await findUserByUsername(" bob", { id: true }))?.id).toBe(padded.id);
    });

    it("finds an account stored with padding by its trimmed name", async () => {
        const padded = await seedUser(" bob");
        expect((await findUserByUsername("bob", { id: true }))?.id).toBe(padded.id);
        expect((await findUserByUsername(" bob\t", { id: true }))?.id).toBe(padded.id);
    });

    it("finds an account stored with tab padding by its trimmed name", async () => {
        const padded = await seedUser("\tbob");
        expect((await findUserByUsername("bob", { id: true }))?.id).toBe(padded.id);
    });

    it("treats every character JavaScript trims as padding, in the lookup and in the shadow check", async () => {
        const padded = await seedUser(" ﻿bob　");
        expect((await findUserByUsername("bob", { id: true }))?.id).toBe(padded.id);
        expect(await plain("bob")).toEqual({ ok: false, reason: "username-taken" });
    });

    it("finds neither of two legacy rows that trim to the same name by that name, and each by its exact form", async () => {
        const left = await seedUser(" bob");
        const right = await seedUser("bob ");
        expect(await findUserByUsername("bob", { id: true })).toBeNull();
        expect((await findUserByUsername(" bob", { id: true }))?.id).toBe(left.id);
        expect((await findUserByUsername("bob ", { id: true }))?.id).toBe(right.id);
    });

    it("prefers the trimmed account over a padded one", async () => {
        await seedUser(" bob");
        const trimmed = await seedUser("bob");
        expect((await findUserByUsername(" bob", { id: true }))?.id).toBe(trimmed.id);
    });

    it("answers null when no account has the name, and returns only the fields asked for", async () => {
        await seedUser("bob");
        expect(await findUserByUsername(" nobody ", { id: true })).toBeNull();
        expect(await findUserByUsername("bob", { username: true })).toEqual({ username: "bob" });
    });
});

describe("deleteAccount", () => {
    it("deletes the account with its settings, and drops the cached user so its token stops working at once", async () => {
        const made = await plain("alice");
        if (!made.ok) throw new Error("setup");
        const token = generateToken({ id: made.user.id, username: "alice", role: "user", tokenVersion: made.user.tokenVersion });
        const passesAuth = async () =>
            (await signedInUser({ headers: { authorization: `Bearer ${token}` }, query: {}, path: "/x" } as any)) !== null;
        expect(await passesAuth()).toBe(true); // and now cached

        expect(await deleteAccount(made.user.id)).toBe(true);

        expect(await prisma.user.findUnique({ where: { id: made.user.id } })).toBeNull();
        expect(await prisma.userSettings.findUnique({ where: { userId: made.user.id } })).toBeNull();
        expect(await passesAuth()).toBe(false);
    });

    it("refuses to delete the only admin with a LastAdminError, and keeps the account", async () => {
        const boss = await seedUser("boss", { role: "admin" });
        await seedUser("alice");

        const refused = await deleteAccount(boss.id).catch((error) => error);

        expect(refused).toBeInstanceOf(LastAdminError);
        expect(await prisma.user.findUnique({ where: { id: boss.id } })).not.toBeNull();
    });

    it("is not told by its message: an error that only says so is no LastAdminError", () => {
        expect(new Error("LAST_ADMIN_GUARD")).not.toBeInstanceOf(LastAdminError);
    });

    it("deletes an admin while another admin remains", async () => {
        const first = await seedUser("boss", { role: "admin" });
        await seedUser("second", { role: "admin" });

        await deleteAccount(first.id);

        expect(await prisma.user.count({ where: { role: "admin" } })).toBe(1);
    });

    it("deletes a plain user without asking about admins", async () => {
        const alice = await seedUser("alice");
        await deleteAccount(alice.id);
        expect(await prisma.user.count()).toBe(0);
    });

    it("leaves one admin when two admins delete themselves together", async () => {
        const a = await seedUser("boss-a", { role: "admin" });
        const b = await seedUser("boss-b", { role: "admin" });

        const outcomes = await Promise.allSettled([deleteAccount(a.id), deleteAccount(b.id)]);

        expect(await prisma.user.count({ where: { role: "admin" } })).toBeGreaterThanOrEqual(1);
        for (const outcome of outcomes) {
            if (outcome.status === "rejected") {
                expect(outcome.reason instanceof LastAdminError || isTransactionConflict(outcome.reason)).toBe(true);
            }
        }
    });

    it("answers false for an account that is already gone", async () => {
        await expect(deleteAccount("nobody")).resolves.toBe(false);
    });
});
