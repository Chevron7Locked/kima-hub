import crypto from "crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-cbc";

// Insecure default that must not be used in production
const INSECURE_DEFAULT = "default-encryption-key-change-me";

/**
 * Get and validate the encryption key from environment
 * Throws error if not set or using insecure default
 */
function getEncryptionKey(): Buffer {
    // Support both SETTINGS_ENCRYPTION_KEY (primary) and ENCRYPTION_KEY (compatibility)
    const key = process.env.SETTINGS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;

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
        // Pad with zeros if too short
        return Buffer.from(key.padEnd(32, "0"));
    }
    // Truncate if too long
    return Buffer.from(key.slice(0, 32));
}

// Validate encryption key on module load to fail fast
const ENCRYPTION_KEY = getEncryptionKey();

/**
 * Encrypt a string using AES-256-CBC
 * Returns empty string for empty/null input
 */
export function encrypt(text: string): string {
    if (!text) return "";
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString("hex") + ":" + encrypted.toString("hex");
}

/**
 * Decrypt a string that was encrypted with the encrypt function
 * Returns empty string for empty/null input
 * Returns original text if decryption fails (for backwards compatibility with unencrypted data)
 */
export function decrypt(text: string): string {
    if (!text) return "";
    try {
        const parts = text.split(":");
        if (parts.length < 2) {
            // Not in expected format, return as-is (might be unencrypted)
            return text;
        }
        const iv = Buffer.from(parts[0], "hex");
        const encryptedText = Buffer.from(parts.slice(1).join(":"), "hex");
        const decipher = crypto.createDecipheriv(
            ALGORITHM,
            ENCRYPTION_KEY,
            iv
        );
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error: any) {
        // If it's a decryption error (wrong key), throw so callers know the value is corrupt
        if (error.code === 'ERR_OSSL_BAD_DECRYPT') {
            throw error;
        }
        // For other errors, log and return original (might be unencrypted)
        logger.error("Decryption error:", error);
        return text;
    }
}

/**
 * Encrypt a field value, returning null for empty/null values
 * Useful for database fields that should store null instead of empty encrypted strings
 */
export function encryptField(value: string | null | undefined): string | null {
    if (!value || value.trim() === "") return null;
    return encrypt(value);
}

/**
 * Decrypt a field value, returning null for null values
 * Returns empty string for empty input
 */
export function decryptField(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return decrypt(value);
}

