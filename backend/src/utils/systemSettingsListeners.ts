/**
 * Who hears about a settings save. Modules add a listener here for the fields they read (`onSystemSettingsChange`),
 * and `saveSystemSettings` (utils/systemSettings.ts) calls it. Kept in a file of its own so a module can add a
 * listener without pulling in the database, and a test that stands in for the settings reader leaves the listeners alone.
 * In-process only: every process that reads settings runs its own save or none at all.
 */
import type { SystemSettings } from "@prisma/client";
import { logger } from "./logger";

/** What a save may set: any column but the row's key and its own timestamps. Credentials go in as plain text. */
export type SystemSettingsChanges = Partial<Omit<SystemSettings, "id" | "createdAt" | "updatedAt">>;
export type SystemSettingsField = keyof SystemSettingsChanges;

interface Listener {
    name: string;
    fields: ReadonlySet<SystemSettingsField>;
    run: (changed: SystemSettingsField[]) => void | Promise<void>;
}

const listeners = new Set<Listener>();

/**
 * Be called, in this process, when a save changes any of `fields`; the listener gets the ones that changed. `name`
 * says whose listener it is, for the log when it fails. A value sent back as it was is no change. Returns the way to
 * remove the listener. The save does not wait for a listener; one that throws or rejects is logged and does not fail
 * the save or the other listeners.
 */
export function onSystemSettingsChange<F extends SystemSettingsField>(
    name: string,
    fields: readonly F[],
    listener: (changed: F[]) => void | Promise<void>,
): () => void {
    const added: Listener = { name, fields: new Set(fields), run: listener as Listener["run"] };
    listeners.add(added);
    return () => {
        listeners.delete(added);
    };
}

/**
 * Call each listener with its own fields that are among `changed`; a listener with none is not called. Each one is
 * started at once and left to finish on its own: the save never waits on one (Soulseek's reconnect can take a
 * while), and a listener that throws or rejects is logged without touching the others.
 */
export function callSettingsListeners(changed: SystemSettingsField[]): void {
    for (const { name, fields, run } of [...listeners]) {
        const heard = changed.filter((field) => fields.has(field));
        if (heard.length === 0) continue;
        const failed = (error: unknown) => logger.warn(`[SETTINGS] The "${name}" listener failed after the save (${heard.join(", ")}):`, error);
        try {
            Promise.resolve(run(heard)).catch(failed);
        } catch (error) {
            failed(error);
        }
    }
}
