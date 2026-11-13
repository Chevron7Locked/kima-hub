/**
 * Who hears about a settings save. Modules sign up here for the fields they read (`onSystemSettingsChange`), and
 * `saveSystemSettings` (utils/systemSettings.ts) tells them. Kept in a file of its own so a module can sign up
 * without pulling in the database, and a test that stands in for the settings reader leaves the sign-ups alone.
 * In-process only: every process that reads settings runs its own save or none at all.
 */
import type { SystemSettings } from "@prisma/client";
import { logger } from "./logger";

/** What a save may set: any column but the row's key and its own timestamps. Credentials go in as plain text. */
export type SystemSettingsChanges = Partial<Omit<SystemSettings, "id" | "createdAt" | "updatedAt">>;
export type SystemSettingsField = keyof SystemSettingsChanges;

interface Subscriber {
    fields: ReadonlySet<SystemSettingsField>;
    listener: (changed: SystemSettingsField[]) => void | Promise<void>;
}

const subscribers = new Set<Subscriber>();

/**
 * Be told, in this process, when a save changes any of `fields`; the listener gets the ones that changed. A value
 * sent back as it was is no change. Returns the way to sign off. A listener that throws is logged and does not
 * fail the save or the other listeners.
 */
export function onSystemSettingsChange<F extends SystemSettingsField>(
    fields: readonly F[],
    listener: (changed: F[]) => void | Promise<void>,
): () => void {
    const subscriber: Subscriber = { fields: new Set(fields), listener: listener as Subscriber["listener"] };
    subscribers.add(subscriber);
    return () => {
        subscribers.delete(subscriber);
    };
}

/** Tell each subscriber which of its own fields are among `changed`; a subscriber with none hears nothing. */
export async function tellSettingsSubscribers(changed: SystemSettingsField[]): Promise<void> {
    await Promise.all(
        [...subscribers].map(async ({ fields, listener }) => {
            const heard = changed.filter((field) => fields.has(field));
            if (heard.length === 0) return;
            try {
                await listener(heard);
            } catch (error) {
                logger.warn(`[SETTINGS] A listener failed after the save (${heard.join(", ")}):`, error);
            }
        }),
    );
}
