/**
 * The one list of SystemSettings fields stored encrypted, with decrypt-on-read
 * (`resolveEncryptedSettings`) and encrypt-on-write (`encryptSettings`). A stored
 * value that cannot be decrypted is an unreadable credential: it is kept, and
 * reads as null, so a key restored later brings it back and ciphertext is never
 * handed to an integration as if it were a key.
 */
import { decrypt, encrypt, isEncryptedFormat } from "./encryption";
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
} as const;

export type EncryptedField = keyof typeof ENCRYPTED_FIELDS;

/** The `SystemSettings` shape with every encrypted field as plaintext. */
export type ResolvedSystemSettings<S> = S & {
    [K in EncryptedField]: string | null;
} & {
    /** The fields held as unreadable: stored, but null above. */
    unreadableFields: EncryptedField[];
};

function encryptedFields(): EncryptedField[] {
    return Object.keys(ENCRYPTED_FIELDS) as EncryptedField[];
}

/** The plaintext of a stored value, or null when this server cannot read it. */
function readStored(stored: string): string | null {
    try {
        const plain = decrypt(stored);
        // Decrypting produced another ciphertext: whatever wrote this value
        // encrypted it twice, and the inner blob is not a key.
        return isEncryptedFormat(plain) ? null : plain;
    } catch {
        return null;
    }
}

function isUnreadable(stored: unknown): boolean {
    return typeof stored === "string" && stored !== "" && readStored(stored) === null;
}

/** Decrypt a single listed field, with no notice (comparison sites). */
export function decryptOrNull(
    field: EncryptedField,
    value: string | null | undefined,
): string | null {
    if (!value) return null;
    const plain = readStored(value);
    if (plain === null) logger.warn(`[Settings] ${ENCRYPTED_FIELDS[field]} could not be decrypted`);
    return plain;
}

/**
 * Read a settings row into usable values: every `ENCRYPTED_FIELDS` entry
 * decrypted, or `null` when it is unset or unreadable. Never writes to the row.
 * Admins hear about every unreadable field, except those `selfRepairing` names for
 * these settings: the integration that owns such a field replaces it itself.
 */
export async function resolveEncryptedSettings<S extends Record<string, unknown>>(
    settings: S,
    selfRepairing: (resolved: ResolvedSystemSettings<S>) => EncryptedField[],
): Promise<ResolvedSystemSettings<S>> {
    const resolved = { ...settings } as Record<string, unknown>;
    const unreadableFields: EncryptedField[] = [];
    for (const field of encryptedFields()) {
        const stored = settings[field];
        const held = typeof stored === "string" && stored !== "";
        const plain = held ? readStored(stored) : null;
        resolved[field] = plain;
        if (held && plain === null) unreadableFields.push(field);
    }
    resolved.unreadableFields = unreadableFields;
    const result = resolved as ResolvedSystemSettings<S>;
    const repairing = selfRepairing(result);
    for (const field of encryptedFields()) {
        await noteReadability(field, !unreadableFields.includes(field) || repairing.includes(field));
    }
    return result;
}

/**
 * Prepare a submitted payload for storage: every supplied `ENCRYPTED_FIELDS`
 * entry encrypted, or null when blank; other entries left as submitted. A blank
 * for a field `current` holds as unreadable is dropped, so the value stays: the
 * settings page sends every field back, and an unreadable one comes back blank.
 */
export function encryptSettings<S extends Record<string, unknown>>(
    settings: S,
    current?: Record<string, unknown> | null,
): Record<string, unknown> {
    const stored = { ...settings } as Record<string, unknown>;
    for (const field of encryptedFields()) {
        const value = settings[field];
        if (value === undefined) continue;
        if (typeof value === "string" && value.trim() !== "") {
            stored[field] = encrypt(value);
        } else if (isUnreadable(current?.[field])) {
            delete stored[field];
        } else {
            stored[field] = null;
        }
    }
    return stored;
}

// Each field's last known state in this process, so one notice per field per
// process, and a field that reads again (right key restored, new value saved)
// takes its notice away.
const lastReadable = new Map<EncryptedField, boolean>();

async function noteReadability(field: EncryptedField, readable: boolean): Promise<void> {
    if (lastReadable.get(field) === readable) return;
    lastReadable.set(field, readable);
    const groupKey = `unreadable-credential:${field}`;
    try {
        if (readable) {
            await notificationService.resolve(groupKey);
            return;
        }
        logger.warn(`[Settings] ${ENCRYPTED_FIELDS[field]} could not be decrypted; kept, and treated as not set`);
        await notificationService.notifyAdmins({
            type: "system",
            title: `${ENCRYPTED_FIELDS[field]} cannot be read`,
            message:
                "The stored value could not be decrypted, so it counts as not set. Restore the server's SETTINGS_ENCRYPTION_KEY, or enter the value again in Settings.",
            groupKey,
            renotify: true,
        });
    } catch (error) {
        logger.warn(`[Settings] Could not update the admin notice about ${field}:`, error);
    }
}
