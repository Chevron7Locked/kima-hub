import { prisma } from "./db";
import { tellSettingsSubscribers, type SystemSettingsChanges, type SystemSettingsField } from "./systemSettingsSubscribers";
import { decryptOrNull, ENCRYPTED_FIELDS, encryptSettings, resolveEncryptedSettings, type EncryptedField } from "./encryptedFields";
import { lidarrSelfRepairingFields } from "../services/lidarrWebhookSecret";

const CACHE_TTL_MS = 60 * 1000;

async function buildSettings() {
    const settings = await prisma.systemSettings.findUnique({
        where: { id: "default" },
    });
    if (!settings) return null;
    return resolveEncryptedSettings(settings, lidarrSelfRepairingFields);
}

let cachedSettings: Awaited<ReturnType<typeof buildSettings>> | null = null;
let cacheExpiry = 0;

export function invalidateSystemSettingsCache() {
    cachedSettings = null;
    cacheExpiry = 0;
}

/** The queue length limit an operator may set (the schema's default is 10000). */
export const QUEUE_LENGTH = { min: 100, max: 100000, default: 10000 } as const;

export async function getSystemSettings() {
    const now = Date.now();
    if (cachedSettings && cacheExpiry > now) {
        return { ...cachedSettings };
    }

    const resolved = await buildSettings();
    if (!resolved) {
        cachedSettings = null;
        cacheExpiry = 0;
        return null;
    }

    cachedSettings = resolved;
    cacheExpiry = now + CACHE_TTL_MS;
    return { ...resolved };
}

export { onSystemSettingsChange } from "./systemSettingsSubscribers";
export type { SystemSettingsChanges, SystemSettingsField } from "./systemSettingsSubscribers";

/** What a stored value means: unset and blank are the same, a credential is its plain text, a date its time. */
function meaning(field: string, stored: unknown): unknown {
    if (field in ENCRYPTED_FIELDS) return decryptOrNull(field as EncryptedField, stored as string | null) ?? null;
    if (stored instanceof Date) return stored.getTime();
    return stored === undefined || stored === "" ? null : stored;
}

/**
 * The one way system settings are saved: writes the supplied fields (a credential given blank is cleared, except one
 * the server cannot read, which stays), drops the settings cache, then tells each subscriber which of its fields
 * changed, without waiting for any of them to finish. Answers the fields whose value changed. The row is read and
 * written under its lock, so two saves at the same time each see the other's result and a change is reported once.
 */
export async function saveSystemSettings(changes: SystemSettingsChanges): Promise<SystemSettingsField[]> {
    const changed = await prisma.$transaction(async (tx) => {
        // A lock needs a row, and an upsert races another creator into a unique-key error, so the row is inserted
        // first (a no-op when it exists) and then locked. A save that creates it has nothing before it to compare with.
        const created = (await tx.systemSettings.createMany({ data: [{ id: "default" }], skipDuplicates: true })).count > 0;
        await tx.$queryRaw`SELECT id FROM "SystemSettings" WHERE id = 'default' FOR UPDATE`;
        const before = created ? null : await tx.systemSettings.findUnique({ where: { id: "default" } });
        const data = encryptSettings(changes as Record<string, unknown>, before) as SystemSettingsChanges;
        const after = await tx.systemSettings.update({ where: { id: "default" }, data });

        return (Object.keys(changes) as SystemSettingsField[]).filter(
            (field) => changes[field] !== undefined && meaning(field, before?.[field]) !== meaning(field, after[field]),
        );
    }, { timeout: 15_000 }); // time spent waiting for the lock counts against it
    invalidateSystemSettingsCache();
    tellSettingsSubscribers(changed);
    return changed;
}
