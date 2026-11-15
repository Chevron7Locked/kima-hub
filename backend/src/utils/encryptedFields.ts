/**
 * The one list of SystemSettings fields stored encrypted, with decrypt-on-read
 * (`decryptSettings`) and encrypt-on-write (`encryptSettings`). A stored
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
 */
export function decryptSettings<S extends Record<string, unknown>>(settings: S): ResolvedSystemSettings<S> {
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
    return resolved as ResolvedSystemSettings<S>;
}

/**
 * Tell admins about every unreadable field of `resolved`, except those `selfRepairing` names for these settings: the
 * integration that owns such a field replaces it itself. A field that reads again takes its notice away. Never rejects.
 */
export async function noteUnreadableCredentials<S extends Record<string, unknown>>(
    resolved: ResolvedSystemSettings<S>,
    selfRepairing: (resolved: ResolvedSystemSettings<S>) => EncryptedField[],
): Promise<void> {
    try {
        const repairing = selfRepairing(resolved);
        for (const field of encryptedFields()) {
            await noteReadability(field, !resolved.unreadableFields.includes(field) || repairing.includes(field));
        }
    } catch (error) {
        logger.warn("[Settings] Could not update the admin notices about unreadable credentials:", error);
    }
}

/** `decryptSettings`, then the notices, waited for: for the places that answer a person and not a cache fill. */
export async function resolveEncryptedSettings<S extends Record<string, unknown>>(
    settings: S,
    selfRepairing: (resolved: ResolvedSystemSettings<S>) => EncryptedField[],
): Promise<ResolvedSystemSettings<S>> {
    const resolved = decryptSettings(settings);
    await noteUnreadableCredentials(resolved, selfRepairing);
    return resolved;
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

// One field's notices run one after another, so a notice still being sent cannot land after the one that takes it
// away. A send that has not finished after this long counts as failed, so a hung store cannot hold the field's line.
const noticeChains = new Map<EncryptedField, Promise<void>>();
const NOTICE_TIMEOUT_MS = 10_000;

function noteReadability(field: EncryptedField, readable: boolean): Promise<void> {
    const run = (noticeChains.get(field) ?? Promise.resolve()).then(() => sendNotice(field, readable));
    noticeChains.set(field, run);
    return run;
}

/** Never rejects. */
async function sendNotice(field: EncryptedField, readable: boolean): Promise<void> {
    if (lastReadable.get(field) === readable) return;
    lastReadable.set(field, readable);
    const groupKey = `unreadable-credential:${field}`;
    let timer: NodeJS.Timeout | undefined;
    try {
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("the notification store did not answer in time")), NOTICE_TIMEOUT_MS);
            timer.unref();
        });
        if (readable) {
            await Promise.race([notificationService.resolve(groupKey), deadline]);
            return;
        }
        logger.warn(`[Settings] ${ENCRYPTED_FIELDS[field]} could not be decrypted; kept, and treated as not set`);
        await Promise.race([
            notificationService.notifyAdmins({
                type: "system",
                title: `${ENCRYPTED_FIELDS[field]} cannot be read`,
                message:
                    "The stored value could not be decrypted, so it counts as not set. Restore the server's SETTINGS_ENCRYPTION_KEY, or enter the value again in Settings.",
                groupKey,
                renotify: true,
            }),
            deadline,
        ]);
    } catch (error) {
        // Not delivered, so not noted: the next read tries again.
        if (lastReadable.get(field) === readable) lastReadable.delete(field);
        logger.warn(`[Settings] Could not update the admin notice about ${field}:`, error);
    } finally {
        clearTimeout(timer);
    }
}
