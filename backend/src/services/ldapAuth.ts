/**
 * LDAP/LLDAP authentication service.
 *
 * This module provides an optional, opt-in LDAP authentication backend. It is
 * designed to work with standard LDAP directories as well as LLDAP. The flow:
 *
 *   1. Bind with the configured service account.
 *   2. Search for the user by the configured filter (default (uid={username})).
 *   3. Attempt a second bind with the user's DN and supplied password.
 *   4. On success, return a normalized profile used by the local auth route.
 *
 * LDAP is only attempted when the `LDAP_ENABLED` environment variable is set to
 * "true" and the local bcrypt check fails. The module does not alter the Prisma
 * schema; auto-provisioned local users get a random placeholder password hash so
 * the non-null `passwordHash` constraint remains satisfied.
 */

import { Client } from "ldapts";
import { getLdapConfig, ldapConfig } from "../config/ldap";
import { logger } from "../utils/logger";

export interface LdapProfile {
    /** Normalized username used for the local Kima account */
    username: string;
    /** Display name from the directory (optional) */
    displayName?: string;
    /** Email address from the directory (optional) */
    email?: string;
    /** Full distinguished name of the LDAP entry */
    dn: string;
}

export interface LdapAuthResult {
    /** Whether authentication succeeded */
    success: boolean;
    /** User profile when authentication succeeded */
    profile?: LdapProfile;
    /** Human-readable failure reason (never includes credentials) */
    error?: string;
}

/**
 * Build the LDAP search filter by substituting the escaped username into the
 * configured filter template.
 */
export function buildUserFilter(username: string): string {
    const config = getLdapConfig();
    const escaped = username.replace(/([\\*()\0])/g, "\\$1");
    return config.userFilter.replace(/\{username\}/g, escaped);
}

/**
 * Extract a single string attribute value from an LDAP entry.
 */
function getAttributeValue(
    attributes: Record<string, string | string[]> | undefined,
    name: string
): string | undefined {
    if (!attributes) return undefined;
    const value = attributes[name];
    if (Array.isArray(value)) return value[0];
    return typeof value === "string" ? value : undefined;
}

function createClient(url: string): Client {
    return new Client({
        url,
    });
}

/**
 * Attempt to authenticate a user against the configured LDAP/LLDAP server.
 *
 * @param username The username (e.g. the LLDAP uid value)
 * @param password The user's plaintext password
 * @returns LdapAuthResult with profile on success, error reason on failure
 */
export async function authenticateLdapUser(
    username: string,
    password: string
): Promise<LdapAuthResult> {
    const config = getLdapConfig();

    if (!config.enabled) {
        return { success: false, error: "LDAP is not enabled" };
    }

    if (!username || !password) {
        return { success: false, error: "Username and password are required" };
    }

    let searchClient: Client | undefined;
    let userClient: Client | undefined;

    try {
        searchClient = createClient(config.url);
        await searchClient.bind(config.bindDn, config.bindPassword);

        const filter = buildUserFilter(username);
        logger.debug(`[LDAP] Searching for user with filter: ${filter}`);

        const { searchEntries } = await searchClient.search(
            config.baseDn,
            {
                scope: "sub",
                filter,
                attributes: [
                    "dn",
                    config.usernameAttribute,
                    "displayName",
                    "mail",
                    "email",
                ],
                sizeLimit: 2,
            }
        );

        if (searchEntries.length === 0) {
            logger.debug(`[LDAP] No user found for filter: ${filter}`);
            return { success: false, error: "User not found" };
        }

        if (searchEntries.length > 1) {
            logger.warn(
                `[LDAP] Filter ${filter} returned ${searchEntries.length} entries; expected one`
            );
            return { success: false, error: "Ambiguous user search result" };
        }

        const entry = searchEntries[0];
        const dn = entry.dn;

        if (!dn) {
            logger.error("[LDAP] Found entry has no distinguished name");
            return { success: false, error: "Invalid LDAP entry" };
        }

        // Verify credentials by binding as the user with their password.
        userClient = createClient(config.url);
        await userClient.bind(dn, password);

        const rawUsername =
            getAttributeValue(entry as Record<string, string | string[]>, config.usernameAttribute) ||
            username;

        const profile: LdapProfile = {
            username: rawUsername.toLowerCase(),
            dn,
            displayName: getAttributeValue(
                entry as Record<string, string | string[]>,
                "displayName"
            ),
            email:
                getAttributeValue(entry as Record<string, string | string[]>, "mail") ||
                getAttributeValue(entry as Record<string, string | string[]>, "email"),
        };

        logger.info(`[LDAP] Successful authentication for ${profile.username}`);
        return { success: true, profile };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[LDAP] Authentication error for ${username}: ${message}`);
        return { success: false, error: "LDAP authentication failed" };
    } finally {
        try {
            await searchClient?.unbind();
        } catch {
            // Ignore unbind errors
        }
        try {
            await userClient?.unbind();
        } catch {
            // Ignore unbind errors
        }
    }
}

/**
 * Check whether LDAP fallback is enabled and minimally configured.
 * Used by the auth route to decide whether to attempt LDAP after local auth
 * failure.
 */
export function isLdapEnabled(): boolean {
    return getLdapConfig().enabled;
}

// Re-export the module-level config so consumers can read default values.
export { ldapConfig };
