/**
 * Encrypted settings, with the real cipher: correct and legacy AES values
 * decrypt; double-encrypted, garbage and other-key values are cleared to null
 * with one "needs re-entry" alert per field per process.
 */

const mockUpdate = jest.fn().mockResolvedValue({});
const mockNotify = jest.fn().mockResolvedValue(undefined);

jest.mock("../db", () => ({
    prisma: {
        systemSettings: { update: (...a: unknown[]) => mockUpdate(...a) },
    },
}));

jest.mock("../../services/notificationService", () => ({
    notificationService: {
        notifyAdmins: (...a: unknown[]) => mockNotify(...a),
    },
}));

jest.mock("../logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import crypto from "crypto";

import {
    ENCRYPTED_FIELDS,
    decryptOrNull,
    encryptSettings,
    resolveEncryptedSettings,
} from "../encryptedFields";
import { encrypt } from "../encryption";
import { legacyEncrypt, SHA256_KEY } from "./legacyCipherFixtures";

beforeEach(() => {
    jest.clearAllMocks();
});

describe("the encrypted settings map", () => {
    it("encrypts on write and decrypts on read with the same map", async () => {
        const submitted = {
            fanartApiKey: "fanart-key",
            slskdApiKey: "slskd-key",
            spotifyClientSecret: "spotify-secret",
            musicPath: "/music", // not an encrypted field
        };

        const stored = encryptSettings(submitted);

        // Stored forms are ciphertext, not the submitted values.
        for (const field of ["fanartApiKey", "slskdApiKey", "spotifyClientSecret"]) {
            expect(stored[field]).not.toBe(submitted[field as keyof typeof submitted]);
            expect(stored[field]).toMatch(/^xc1\./);
        }
        // Untouched keys pass through as submitted.
        expect(stored.musicPath).toBe("/music");

        const resolved = await resolveEncryptedSettings(stored);
        expect(resolved.fanartApiKey).toBe("fanart-key");
        expect(resolved.slskdApiKey).toBe("slskd-key");
        expect(resolved.spotifyClientSecret).toBe("spotify-secret");
        // Nothing broken here, so no re-seed writes.
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("maps every encrypted settings field", () => {
        // Every encrypted SystemSettings field, read and write side alike.
        expect(Object.keys(ENCRYPTED_FIELDS)).toHaveLength(9);
        for (const field of ["fanartApiKey", "slskdApiKey", "spotifyClientSecret",
            "lidarrApiKey", "lidarrWebhookSecret", "acoustidApiKey",
            "audiobookshelfApiKey", "soulseekPassword", "aiApiKey"]) {
            expect(ENCRYPTED_FIELDS).toHaveProperty(field);
        }
    });
});

describe("broken stored values re-seed to \"needs re-entry\"", () => {
    it("re-seeds a double-encrypted value and notifies admins", async () => {
        // Decrypting once yields another ciphertext, which is not a key.
        const settings = { lidarrApiKey: encrypt(encrypt("lidarr-key-from-2024")) };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.lidarrApiKey).toBeNull();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "default" },
                data: { lidarrApiKey: null },
            }),
        );
        expect(mockNotify).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "Lidarr API key needs re-entry",
                message: expect.stringContaining("could not be decrypted"),
            }),
        );
    });

    it("re-seeds a value that is in no encrypted format at all", async () => {
        // Never-decrypted: plaintext written straight into the column.
        // Handing it back would pass a never-encrypted value through as a
        // credential.
        const settings = { fanartApiKey: "plaintext-never-encrypted" };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.fanartApiKey).toBeNull();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { fanartApiKey: null } }),
        );
    });

    it("re-seeds a ciphertext written under a different key", async () => {
        // Key rotation: the stored value decrypts only under a different key.
        const settings = {
            acoustidApiKey: legacyEncrypt("acoustid-key-from-before-rotation",
                crypto.randomBytes(32)),
        };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.acoustidApiKey).toBeNull();
        expect(mockUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: { acoustidApiKey: null } }),
        );
    });

    it("notifies once per field even when the broken value is read twice", async () => {
        // One "needs re-entry" notice per field per process — the clearing
        // is idempotent, the notification must not spam the admin.
        const settings = { soulseekPassword: encrypt(encrypt("hunter2")) };

        await resolveEncryptedSettings(settings);
        await resolveEncryptedSettings(settings);

        const soulseekNotices = mockNotify.mock.calls.filter(
            ([alert]) => alert.title === "Soulseek password needs re-entry",
        );
        expect(soulseekNotices).toHaveLength(1);
    });
});

describe("readable stored values resolve", () => {
    it("decrypts a correct ciphertext and a legacy AES one, without re-seeding", async () => {
        const settings = {
            soulseekPassword: encrypt("soulseek-pass"),
            audiobookshelfApiKey: legacyEncrypt("abs-key", SHA256_KEY),
        };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.soulseekPassword).toBe("soulseek-pass");
        expect(resolved.audiobookshelfApiKey).toBe("abs-key");
        expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("keeps unset and empty values null without re-seeding", async () => {
        const settings = { lidarrWebhookSecret: "", spotifyClientSecret: null };

        const resolved = await resolveEncryptedSettings(settings);

        expect(resolved.lidarrWebhookSecret).toBeNull();
        expect(resolved.spotifyClientSecret).toBeNull();
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});

describe("decryptOrNull (comparison sites)", () => {
    it("returns null for a double-encrypted value but does not re-seed", async () => {
        // Comparison sites must not rewrite the row while merely looking.
        expect(
            decryptOrNull("lidarrApiKey", encrypt(encrypt("lidarr-key-from-2024"))),
        ).toBeNull();
        expect(decryptOrNull("lidarrApiKey", "garbage")).toBeNull();
        expect(decryptOrNull("lidarrApiKey", encrypt("lidarr-key"))).toBe("lidarr-key");
        expect(mockUpdate).not.toHaveBeenCalled();
    });
});
