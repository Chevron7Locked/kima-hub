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
    name: string;
    fields: ReadonlySet<SystemSettingsField>;
    listener: (changed: SystemSettingsField[]) => void | Promise<void>;
}

const subscribers = new Set<Subscriber>();

/**
 * Be told, in this process, when a save changes any of `fields`; the listener gets the ones that changed. `name` says
 * who is listening, for the log when the listener fails. A value
 * sent back as it was is no change. Returns the way to sign off. The save does not wait for a listener; one that
 * throws or rejects is logged and does not fail the save or the other listeners.
 */
export function onSystemSettingsChange<F extends SystemSettingsField>(
    name: string,
    fields: readonly F[],
    listener: (changed: F[]) => void | Promise<void>,
): () => void {
    const subscriber: Subscriber = { name, fields: new Set(fields), listener: listener as Subscriber["listener"] };
    subscribers.add(subscriber);
    return () => {
        subscribers.delete(subscriber);
    };
}

/**
 * Tell each subscriber which of its own fields are among `changed`; a subscriber with none hears nothing. Each
 * listener is started at once and left to finish on its own: the save never waits on one (Soulseek's reconnect can
 * take a while), and a listener that throws or rejects is logged without touching the others.
 */
export function tellSettingsSubscribers(changed: SystemSettingsField[]): void {
    for (const { name, fields, listener } of [...subscribers]) {
        const heard = changed.filter((field) => fields.has(field));
        if (heard.length === 0) continue;
        const failed = (error: unknown) => logger.warn(`[SETTINGS] The "${name}" listener failed after the save (${heard.join(", ")}):`, error);
        try {
            Promise.resolve(listener(heard)).catch(failed);
        } catch (error) {
            failed(error);
        }
    }
}
