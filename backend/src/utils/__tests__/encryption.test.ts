/**
 * Encryption refuses anything it did not produce and still reads legacy
 * AES-256-CBC values, whose fixtures are built with `crypto` directly.
 */
import crypto from "crypto";
import { decrypt, encrypt, encryptField } from "../encryption";
import { ENV_KEY, legacyEncrypt, SHA256_KEY } from "./legacyCipherFixtures";

/** The other legacy derivation: the first 32 bytes of the raw env var. */
const RAW32_KEY = Buffer.from(ENV_KEY.slice(0, 32));

function paddingPasses(stored: string, key: Buffer): boolean {
    const [iv, body] = stored.split(":");
    try {
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(iv, "hex"));
        Buffer.concat([decipher.update(Buffer.from(body, "hex")), decipher.final()]);
        return true;
    } catch {
        return false;
    }
}

/** A value stored under a stranger's key whose padding still checks out under `key`. */
function wrongKeyThatPassesPadding(text: string, key: Buffer): string {
    for (let i = 0; i < 5000; i++) {
        const stored = legacyEncrypt(text, crypto.randomBytes(32));
        if (paddingPasses(stored, key)) return stored;
    }
    throw new Error("no wrong-key ciphertext found whose padding passes");
}

describe("at-rest encryption", () => {
    it("round-trips, including unicode and a long value", () => {
        for (const value of ["hunter2", "sk-Ab3_x-9", "päßwörd 🎵 ключ", "k".repeat(4096)]) {
            expect(decrypt(encrypt(value))).toBe(value);
        }
    });

    it("never produces the same ciphertext twice for the same plaintext", () => {
        // A fresh nonce per encryption. Equal ciphertexts would mean equal
        // nonces, which for XChaCha20 is the one failure that silently
        // destroys confidentiality rather than throwing.
        const a = encrypt("the same secret");
        const b = encrypt("the same secret");
        expect(a).not.toBe(b);
        expect(decrypt(a)).toBe("the same secret");
        expect(decrypt(b)).toBe("the same secret");
    });

    it("throws when a single byte of the ciphertext is flipped", () => {
        // Fails closed: the caller must never read back a value an attacker
        // modified in the database.
        const sealed = encrypt("sk-live-do-not-change-me");
        const blob = Buffer.from(sealed.slice("xc1.".length), "base64url");
        blob[blob.length - 5] ^= 0x01;
        const tampered = "xc1." + blob.toString("base64url");

        expect(tampered).not.toBe(sealed);
        expect(() => decrypt(tampered)).toThrow();
    });

    it("throws when the nonce is altered, not just the ciphertext body", () => {
        const sealed = encrypt("sk-live-do-not-change-me");
        const blob = Buffer.from(sealed.slice("xc1.".length), "base64url");
        blob[0] ^= 0xff;
        expect(() => decrypt("xc1." + blob.toString("base64url"))).toThrow();
    });

    it("throws on a truncated value rather than reading a short buffer", () => {
        const sealed = encrypt("sk-live-do-not-change-me");
        const blob = Buffer.from(sealed.slice("xc1.".length), "base64url");
        expect(() => decrypt("xc1." + blob.subarray(0, 20).toString("base64url"))).toThrow(
            /too short/
        );
        expect(() => decrypt("xc1." + blob.subarray(0, 30).toString("base64url"))).toThrow();
    });

    it("throws on plaintext instead of handing it back", () => {
        // Anything unrecognised must not come back to the caller as though it
        // were the decrypted value: database write access alone would then be
        // enough to inject a credential.
        for (const notCiphertext of [
            "sk-attacker-controlled-key",
            "https://evil.example/api",
            "not:hex:at:all",
            "xc1.",
            "xc1.!!!not-base64!!!",
        ]) {
            expect(() => decrypt(notCiphertext)).toThrow();
        }
    });

    it("still reads a legacy AES-256-CBC value", () => {
        const stored = legacyEncrypt("lidarr-api-key-from-production", SHA256_KEY);
        expect(decrypt(stored)).toBe("lidarr-api-key-from-production");
    });

    it("still reads a value keyed by the first 32 bytes of the raw env var", () => {
        const stored = legacyEncrypt("pre-normalization-secret", RAW32_KEY);
        expect(decrypt(stored)).toBe("pre-normalization-secret");
    });

    it("throws on an AES-shaped value encrypted under someone else's key", () => {
        expect(() => decrypt(legacyEncrypt("not yours", crypto.randomBytes(32)))).toThrow();
    });

    it("throws, never hands back garbage, when a wrong key happens to pass the padding check", () => {
        // CBC has no MAC: about one wrong key in 256 decrypts with valid padding to random bytes. Find one.
        const stored = wrongKeyThatPassesPadding("lidarr-api-key", SHA256_KEY);
        expect(() => decrypt(stored)).toThrow(/not encrypted with this server's key/);
    });

    it("reads a value under the older derivation even when the current key passes the padding check on it", () => {
        // The first key's lucky padding must not stop the second key from being tried.
        for (let i = 0; i < 5000; i++) {
            const stored = legacyEncrypt("pre-normalization-secret", RAW32_KEY);
            if (!paddingPasses(stored, SHA256_KEY)) continue;
            expect(decrypt(stored)).toBe("pre-normalization-secret");
            return;
        }
        throw new Error("no ciphertext found whose padding passes under the current key");
    });

    it("refuses a legacy value that decrypts to control characters, which no stored text holds", () => {
        expect(() => decrypt(legacyEncrypt("ab\u0001c", SHA256_KEY))).toThrow(/not encrypted with this server's key/);
        expect(() => decrypt(legacyEncrypt("ab\u0085c", SHA256_KEY))).toThrow(/not encrypted with this server's key/);
    });

    it("keeps a leading byte-order mark, as the legacy decoding does", () => {
        expect(decrypt(legacyEncrypt("\ufeffkey", SHA256_KEY))).toBe("\ufeffkey");
    });

    it("still reads every kind of text a setting holds", () => {
        for (const value of ["päßwörd 🎵 ключ", "tab\tand\nline breaks\r\n", '["code-1","code-2"]', "a"]) {
            expect(decrypt(legacyEncrypt(value, SHA256_KEY))).toBe(value);
        }
    });

    it("treats empty as empty, at both ends", () => {
        expect(encrypt("")).toBe("");
        expect(decrypt("")).toBe("");
        expect(encryptField("")).toBeNull();
        expect(encryptField("   ")).toBeNull();
        expect(encryptField(null)).toBeNull();
        expect(encryptField(undefined)).toBeNull();
    });

    it("encryptField produces something decrypt accepts, and not the plaintext", () => {
        const stored = encryptField("audiobookshelf-token");
        expect(stored).not.toBeNull();
        expect(stored).not.toContain("audiobookshelf-token");
        expect(stored?.startsWith("xc1.")).toBe(true);
        expect(decrypt(stored as string)).toBe("audiobookshelf-token");
    });

    it("writes the xc1. format", () => {
        expect(encrypt("anything").startsWith("xc1.")).toBe(true);
    });
});
