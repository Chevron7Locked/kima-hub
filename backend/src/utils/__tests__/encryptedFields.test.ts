/**
 * The encrypted settings map, with the real cipher: correct and legacy AES values decrypt, and nothing that cannot be
 * read is ever handed on. What happens to an unreadable value in storage is in
 * routes/__tests__/unreadableCredentials.route.test.ts.
 */

import {
    ENCRYPTED_FIELDS,
    decryptOrNull,
    encryptSettings,
    resolveEncryptedSettings,
} from "../encryptedFields";
import { encrypt } from "../encryption";
import { legacyEncrypt, SHA256_KEY } from "./legacyCipherFixtures";

describe("the encrypted settings map", () => {
    it("encrypts on write and decrypts on read with the same map", async () => {
        const submitted = {
            fanartApiKey: "fanart-key",
            slskdApiKey: "slskd-key",
            acoustidApiKey: "acoustid-key",
            musicPath: "/music", // not an encrypted field
        };

        const stored = encryptSettings(submitted);

        // Stored forms are ciphertext, not the submitted values.
        for (const field of ["fanartApiKey", "slskdApiKey", "acoustidApiKey"]) {
            expect(stored[field]).not.toBe(submitted[field as keyof typeof submitted]);
            expect(stored[field]).toMatch(/^xc1\./);
        }
        // Untouched keys pass through as submitted.
        expect(stored.musicPath).toBe("/music");

        const resolved = await resolveEncryptedSettings(stored, () => []);
        expect(resolved.fanartApiKey).toBe("fanart-key");
        expect(resolved.slskdApiKey).toBe("slskd-key");
        expect(resolved.acoustidApiKey).toBe("acoustid-key");
    });

    it("stores a blank as null, so no plain text reaches an encrypted column", () => {
        const stored = encryptSettings({ fanartApiKey: "   ", slskdApiKey: "", lidarrApiKey: null });

        expect(stored).toEqual({ fanartApiKey: null, slskdApiKey: null, lidarrApiKey: null });
    });

    it("leaves alone a field the payload does not supply", () => {
        expect(encryptSettings({ fanartApiKey: undefined, musicPath: "/music" })).toEqual({
            fanartApiKey: undefined,
            musicPath: "/music",
        });
    });

    it("maps every encrypted settings field", () => {
        // Every encrypted SystemSettings field, read and write side alike.
        expect(Object.keys(ENCRYPTED_FIELDS)).toHaveLength(7);
        for (const field of ["fanartApiKey", "slskdApiKey",
            "lidarrApiKey", "lidarrWebhookSecret", "acoustidApiKey",
            "audiobookshelfApiKey", "soulseekPassword"]) {
            expect(ENCRYPTED_FIELDS).toHaveProperty(field);
        }
    });
});

describe("readable stored values resolve", () => {
    it("decrypts a correct ciphertext and a legacy AES one", async () => {
        const settings = {
            soulseekPassword: encrypt("soulseek-pass"),
            audiobookshelfApiKey: legacyEncrypt("abs-key", SHA256_KEY),
        };

        const resolved = await resolveEncryptedSettings(settings, () => []);

        expect(resolved.soulseekPassword).toBe("soulseek-pass");
        expect(resolved.audiobookshelfApiKey).toBe("abs-key");
    });

    it("keeps unset and empty values null", async () => {
        const settings = { lidarrWebhookSecret: "", slskdApiKey: null };

        const resolved = await resolveEncryptedSettings(settings, () => []);

        expect(resolved.lidarrWebhookSecret).toBeNull();
        expect(resolved.slskdApiKey).toBeNull();
    });
});

describe("decryptOrNull (comparison sites)", () => {
    it("returns null for what cannot be read", () => {
        expect(
            decryptOrNull("lidarrApiKey", encrypt(encrypt("lidarr-key-from-2024"))),
        ).toBeNull();
        expect(decryptOrNull("lidarrApiKey", "garbage")).toBeNull();
        expect(decryptOrNull("lidarrApiKey", encrypt("lidarr-key"))).toBe("lidarr-key");
    });
});
