export const AUTH_PROVIDERS = loadAuthProviders();

export enum AuthType {
    CREDENTIALS,
    OIDC
}

export interface AuthProvider {
    name: string;
    type: AuthType;
}

export interface OidcProvider extends AuthProvider {
    issuer: string;
    clientId: string;
    clientSecret: string;
    roleField?: string;
}

function loadAuthProviders(): Map<string, AuthProvider> {
    // Check for OIDC providers from environment variables
    // Format: OIDC_PROVIDERS=keycloak:Keycloak SSO,authentik:Authentik

    const providers = new Map<string, AuthProvider>();

    if (process.env.DISABLE_CREDENTIALS_PROVIDER !== "true") {
        providers.set("credentials", {
            name: "Lidify",
            type: AuthType.CREDENTIALS
        });
    }

    const oidcProvidersEnv = process.env.OIDC_PROVIDERS;
    if (oidcProvidersEnv) {
        const oidcProvidersList = oidcProvidersEnv.split(',').map(p => p.trim());
        for (const provider of oidcProvidersList) {
            const [id, name] = provider.split(':');
            if (id && name) {
                // These IDs need to be unique
                if (providers.has(id)) {
                    throw new Error(`Duplicate OIDC provider id found: ${id}`);
                }
                // Check if the provider has required env vars
                const hasConfig = process.env[`OIDC_${id.toUpperCase()}_ISSUER`] &&
                    process.env[`OIDC_${id.toUpperCase()}_CLIENT_ID`] &&
                    process.env[`OIDC_${id.toUpperCase()}_CLIENT_SECRET`];
                if (!hasConfig) {
                    throw new Error(`Missing configuration for OIDC provider: ${id}`);
                }

                providers.set(id, {
                    name,
                    type: AuthType.OIDC,
                    issuer: process.env[`OIDC_${id.toUpperCase()}_ISSUER`],
                    clientId: process.env[`OIDC_${id.toUpperCase()}_CLIENT_ID`],
                    clientSecret: process.env[`OIDC_${id.toUpperCase()}_CLIENT_SECRET`],
                    roleField: process.env[`OIDC_${id.toUpperCase()}_ROLE_FIELD`],
                } as OidcProvider);
            }
        }
    }

    if (providers.size === 0) {
        throw new Error("No authentication providers configured");
    }

    return providers;
}
