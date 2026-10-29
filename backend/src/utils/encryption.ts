/**
 * At-rest encryption for the SystemSettings fields in ENCRYPTED_FIELDS and the
 * User 2FA secret and recovery codes: XChaCha20-Poly1305 with a random 24-byte
 * nonce. `decrypt` fails closed; resolveEncryptedSettings turns a throw into
 * null. Old AES-256-CBC values still read until rewritten; 2FA rows never are.
 */
import crypto from "crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { logger } from "./logger";

const LEGACY_ALGORITHM = "aes-256-cbc";

/** Tag on the new format. Anything without it is read as legacy, or refused. */
const V2_PREFIX = "xc1.";
const V2_INFO = Buffer.from("kima-settings/xc1", "utf8");
const NONCE_BYTES = 24;

// Insecure default that must not be used in production
const INSECURE_DEFAULT = "default-encryption-key-change-me";

/** The configured secret: SETTINGS_ENCRYPTION_KEY, else ENCRYPTION_KEY (the older name, still read). */
function configuredSecret(): string | undefined {
    return process.env.SETTINGS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
}

/** The secret, checked (set, not the insecure default), as a 256-bit key; throws when it is unusable. */
function getEncryptionKey(): Buffer {
    const key = configuredSecret();

    if (!key) {
        throw new Error(
            "CRITICAL: SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY environment variable must be set.\n" +
            "This key is required to encrypt sensitive data (API keys, passwords, 2FA secrets).\n" +
            "Generate a secure key with: openssl rand -base64 32"
        );
    }

    if (key === INSECURE_DEFAULT) {
        throw new Error(
            "CRITICAL: Encryption key is set to the insecure default value.\n" +
            "You must set a unique SETTINGS_ENCRYPTION_KEY or ENCRYPTION_KEY.\n" +
            "Generate a secure key with: openssl rand -base64 32"
        );
    }

    if (key.length < 32) {
        logger.warn("SETTINGS_ENCRYPTION_KEY is shorter than 32 characters. Consider using a 32+ char key.");
    }
    // Always derive key via SHA-256 for consistent 256-bit key regardless of input length
    return crypto.createHash("sha256").update(key).digest();
}

// Validate encryption key on module load to fail fast
const ENCRYPTION_KEY = getEncryptionKey();

/**
 * The XChaCha key is a separate derivation from the same secret, not the same
 * 32 bytes reused. One key, one cipher: an AES key and an AEAD key that happen
 * to be equal is the kind of coincidence that becomes a cross-protocol bug the
 * moment anything else starts using either.
 */
const V2_KEY = Buffer.from(
    crypto.hkdfSync("sha256", ENCRYPTION_KEY, Buffer.alloc(0), V2_INFO, 32)
);

// Legacy key derivation for backward compatibility with data encrypted before SHA-256 normalization
function getLegacyEncryptionKey(): Buffer | null {
    const key = configuredSecret();
    if (!key || key.length < 32) return null; // Short keys already used SHA-256
    return Buffer.from(key.slice(0, 32));
}
const LEGACY_KEY = getLegacyEncryptionKey();

/** `ivHex:ciphertextHex` -- the shape every AES-256-CBC value already stored has. */
const LEGACY_SHAPE = /^[0-9a-f]{32}:[0-9a-f]+$/i;

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

/**
 * Encrypt a string with XChaCha20-Poly1305.
 * Returns empty string for empty/null input.
 */
export function encrypt(text: string): string {
    if (!text) return "";
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const sealed = xchacha20poly1305(V2_KEY, nonce, V2_INFO).encrypt(
        Buffer.from(text, "utf8")
    );
    return V2_PREFIX + toBase64Url(Buffer.concat([nonce, Buffer.from(sealed)]));
}

/**
 * Decrypt a value from `encrypt` or the older AES-256-CBC format. Throws on
 * tampered, truncated, wrong-key or unrecognised input, never returning it as plaintext.
 */
export function decrypt(text: string): string {
    if (!text) return "";

    if (text.startsWith(V2_PREFIX)) {
        const blob = Buffer.from(text.slice(V2_PREFIX.length), "base64url");
        if (blob.length <= NONCE_BYTES) {
            throw new Error("Decryption failed: ciphertext is too short to be valid");
        }
        // Poly1305 verification happens inside decrypt(); a modified byte
        // anywhere in nonce, ciphertext or tag throws rather than returning
        // plausible-looking bytes.
        const opened = xchacha20poly1305(
            V2_KEY,
            blob.subarray(0, NONCE_BYTES),
            V2_INFO
        ).decrypt(blob.subarray(NONCE_BYTES));
        return Buffer.from(opened).toString("utf8");
    }

    if (LEGACY_SHAPE.test(text)) {
        return decryptLegacy(text);
    }

    // No recognised format: refuse it, or anyone with database access could write
    // a readable credential without the key.
    throw new Error(
        "Decryption failed: value is not in a recognised encrypted format. " +
        "If this is a credential stored before encryption existed, re-enter it in Settings."
    );
}

/**
 * Every value Kima stored is text: valid UTF-8 with no control characters but tab and line breaks. AES-256-CBC has no
 * MAC, so a wrong key passes the padding check about 1 time in 256; requiring stored text refuses the random bytes it
 * gives, so a wrong key is accepted about once in 31 million instead. A leading byte-order mark is kept, as before.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function asStoredText(bytes: Buffer): string | null {
    let text: string;
    try {
        text = STRICT_UTF8.decode(bytes);
    } catch {
        return null;
    }
    return NOT_TEXT.test(text) ? null : text;
}

/** AES-256-CBC, both key derivations, for values written before `xc1.`. */
function decryptLegacy(text: string): string {
    const parts = text.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = Buffer.from(parts.slice(1).join(":"), "hex");

    // Text under this key, or null: a padding failure and padding that passed by chance on bytes that are
    // not text both mean "not this key".
    const attempt = (key: Buffer): string | null => {
        let bytes: Buffer;
        try {
            const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
            bytes = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
        } catch {
            return null;
        }
        return asStoredText(bytes);
    };

    // The pre-SHA-256 derivation (the first 32 bytes of the raw env var) is tried when the current one fails.
    const plain = attempt(ENCRYPTION_KEY) ?? (LEGACY_KEY ? attempt(LEGACY_KEY) : null);
    if (plain === null) {
        throw new Error("Decryption failed: the value was not encrypted with this server's key");
    }
    return plain;
}

/** Whether a value carries either recognised format (`xc1.` or `iv:cipher`). */
export function isEncryptedFormat(value: string): boolean {
    return value.startsWith(V2_PREFIX) || LEGACY_SHAPE.test(value);
}

/**
 * Encrypt a field value, returning null for empty/null values
 * Useful for database fields that should store null instead of empty encrypted strings
 */
export function encryptField(value: string | null | undefined): string | null {
    if (!value || value.trim() === "") return null;
    return encrypt(value);
}
