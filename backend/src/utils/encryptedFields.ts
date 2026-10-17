/**
 * The one list of SystemSettings fields stored encrypted, with decrypt-on-read
 * (`resolveEncryptedSettings`) and encrypt-on-write (`encryptSettings`). A value
 * that no longer decrypts is reset to null and admins are notified: an
 * unreadable credential is never used as if it were one.
 */
import { decrypt, encrypt, isEncryptedFormat } from "./encryption";
import { prisma } from "./db";
import { logger } from "./logger";
import { notificationService } from "../services/notificationService";

export const ENCRYPTED_FIELDS = {
    lidarrApiKey: "Lidarr API key",
    lidarrWebhookSecret: "Lidarr webhook secret",
    fanartApiKey: "Fanart.tv API key",
    acoustidApiKey: "AcoustID API key",
    audiobookshelfApiKey: "Audiobookshelf API key",
    soulseekPassword: "Soulseek password",
    slskdApiKey: "slskd API key",
    spotifyClientSecret: "Spotify client secret",
    aiApiKey: "AI provider API key",
} as const;

export type EncryptedField = keyof typeof ENCRYPTED_FIELDS;

/** The `SystemSettings` shape with every encrypted field as plaintext. */
export type ResolvedSystemSettings<S> = S & {
    [K in EncryptedField]: string | null;
};

function encryptedFields(): EncryptedField[] {
    return Object.keys(ENCRYPTED_FIELDS) as EncryptedField[];
}

/** Decrypt a single listed field without re-seeding (comparison sites). */
export function decryptOrNull(
    field: EncryptedField,
    value: string | null | undefined,
): string | null {
    if (!value) return null;
    try {
        const plain = decrypt(value);
        return isEncryptedFormat(plain) ? null : plain;
    } catch (error) {
        logger.warn(`[Settings] ${ENCRYPTED_FIELDS[field]} could not be decrypted`, error);
        return null;
    }
}

/**
 * Read a settings row into usable values: every `ENCRYPTED_FIELDS` entry
 * decrypted, or `null` plus a re-seed when it cannot be decrypted.
 */
export async function resolveEncryptedSettings<S extends Record<string, unknown>>(
    settings: S,
): Promise<ResolvedSystemSettings<S>> {
    const resolved = { ...settings } as Record<string, unknown>;
    for (const field of encryptedFields()) {
        const stored = settings[field];
        if (typeof stored !== "string" || stored === "") {
            resolved[field] = null;
            continue;
        }
        let plain: string;
        try {
            plain = decrypt(stored);
        } catch {
            await reseedUnreadableField(field);
            resolved[field] = null;
            continue;
        }
        if (isEncryptedFormat(plain)) {
            // Decrypting produced another ciphertext — whatever wrote this
            // value encrypted it twice, and the inner blob is not a key.
            await reseedUnreadableField(field);
            resolved[field] = null;
            continue;
        }
        resolved[field] = plain;
    }
    return resolved as ResolvedSystemSettings<S>;
}

/**
 * Prepare a submitted payload for storage: every supplied
 * `ENCRYPTED_FIELDS` entry encrypted, untouched entries left as submitted.
 */
export function encryptSettings<S extends Record<string, unknown>>(
    settings: S,
): Record<string, unknown> {
    const stored = { ...settings } as Record<string, unknown>;
    for (const field of encryptedFields()) {
        const value = settings[field];
        if (typeof value === "string" && value !== "") {
            stored[field] = encrypt(value);
        }
    }
    return stored;
}

// One "needs re-entry" notification per field per process; the clearing
// itself is idempotent, and the log line repeats so a quiet process does
// not hide a broken key from whoever reads logs.
const notifiedReEntry = new Set<EncryptedField>();

async function reseedUnreadableField(field: EncryptedField): Promise<void> {
    try {
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { [field]: null },
        });
        logger.warn(
            `[Settings] ${ENCRYPTED_FIELDS[field]} could not be decrypted; cleared — re-entry needed`,
        );
    } catch (error) {
        logger.warn(`[Settings] Could not clear unreadable ${field}:`, error);
        return;
    }
    if (notifiedReEntry.has(field)) return;
    notifiedReEntry.add(field);
    try {
        await notificationService.notifyAdmins({
            type: "system",
            title: `${ENCRYPTED_FIELDS[field]} needs re-entry`,
            message: "The stored value could not be decrypted, so it has been cleared; enter it again in Settings.",
        });
    } catch (error) {
        logger.warn(`[Settings] Could not notify admins about ${field}:`, error);
    }
}