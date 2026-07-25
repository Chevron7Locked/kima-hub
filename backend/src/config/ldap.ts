import { logger } from "../utils/logger";

/**
 * Optional LDAP/LLDAP authentication configuration.
 *
 * All LDAP features are opt-in via environment variables. When LDAP_ENABLED
 * is not set to "true", Kima behaves exactly as before and only uses local
 * bcrypt authentication.
 *
 * Environment variables:
 *   LDAP_ENABLED             - "true" to enable LDAP fallback
 *   LDAP_URL                   - LDAP server URL, e.g. ldap://192.168.68.71:3890
 *   LDAP_BIND_DN               - Service account DN for directory lookups
 *   LDAP_BIND_PASSWORD         - Service account password
 *   LDAP_BASE_DN               - Base DN for user searches
 *   LDAP_USER_FILTER           - Filter template, e.g. (uid={username})
 *   LDAP_USERNAME_ATTRIBUTE    - Attribute used for the local username (default: uid)
 *   LDAP_DEFAULT_ROLE          - Role assigned to auto-provisioned users (default: user)
 */
export interface LdapConfig {
    enabled: boolean;
    url: string;
    bindDn: string;
    bindPassword: string;
    baseDn: string;
    userFilter: string;
    usernameAttribute: string;
    defaultRole: "user" | "admin";
}

function parseBoolean(value: string | undefined): boolean {
    return value === "true" || value === "1" || value === "yes";
}

export function getLdapConfig(): LdapConfig {
    const enabled = parseBoolean(process.env.LDAP_ENABLED);

    const defaultRole = process.env.LDAP_DEFAULT_ROLE;
    const role: "user" | "admin" =
        defaultRole === "admin" ? "admin" : "user";

    return {
        enabled,
        url: process.env.LDAP_URL || "",
        bindDn: process.env.LDAP_BIND_DN || "",
        bindPassword: process.env.LDAP_BIND_PASSWORD || "",
        baseDn: process.env.LDAP_BASE_DN || "",
        userFilter: process.env.LDAP_USER_FILTER || "(uid={username})",
        usernameAttribute: process.env.LDAP_USERNAME_ATTRIBUTE || "uid",
        defaultRole: role,
    };
}

function logLdapConfig(config: LdapConfig) {
    if (!config.enabled) return;

    const missing: string[] = [];
    if (!config.url) missing.push("LDAP_URL");
    if (!config.bindDn) missing.push("LDAP_BIND_DN");
    if (!config.bindPassword) missing.push("LDAP_BIND_PASSWORD");
    if (!config.baseDn) missing.push("LDAP_BASE_DN");

    if (missing.length > 0) {
        logger.error(
            `[LDAP] LDAP_ENABLED is true but required variables are missing: ${missing.join(", ")}`
        );
    } else {
        logger.info(
            `[LDAP] LDAP authentication enabled against ${config.url} (base DN: ${config.baseDn})`
        );
    }
}

// Module-level config is evaluated once at startup for validation/logging.
export const ldapConfig = getLdapConfig();
logLdapConfig(ldapConfig);
