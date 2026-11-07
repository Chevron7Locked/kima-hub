/**
 * What Kima knows about the Lidarr webhook secret in the settings it has read.
 * Kept apart from the webhook setup so the settings reader can use it without
 * loading the setup, which itself reads settings.
 */

import type { SystemSettings } from "@prisma/client";
import type { EncryptedField, ResolvedSystemSettings } from "../utils/encryptedFields";

type Resolved = ResolvedSystemSettings<SystemSettings>;

/** Settings as `getSystemSettings` returns them. */
export type WebhookSecretSettings = Pick<Resolved, "lidarrWebhookSecret" | "unreadableFields">;

/** An unreadable secret is still a stored one: nothing can match it until Kima replaces it. */
export function lidarrWebhookSecretHeld(settings: WebhookSecretSettings | null | undefined): boolean {
    return !!settings && (!!settings.lidarrWebhookSecret || settings.unreadableFields.includes("lidarrWebhookSecret"));
}

/** Fields Kima replaces by itself when unreadable, so admins need no notice: the secret, while the Lidarr API key reads. */
export function lidarrSelfRepairingFields(resolved: Pick<Resolved, "lidarrApiKey">): EncryptedField[] {
    return resolved.lidarrApiKey !== null ? ["lidarrWebhookSecret"] : [];
}
