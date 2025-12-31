import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

// Keep a minimal UserManager cache only for metadata parsing if needed
const userManagers: Map<string, UserManager> = new Map();

export const AUTH_PROVIDERS = loadAuthProviders();

export interface AuthProvider {
    id: string;
    name: string;
    type: string;
    oidcIssuer?: string;
    oidcClientId?: string;
    // Optional discovery metadata if the backend provides it through /api/auth/providers
    discovery?: {
        authorization_endpoint?: string;
        token_endpoint?: string;
        userinfo_endpoint?: string;
        end_session_endpoint?: string;
        jwks_uri?: string;
    };
}

async function loadAuthProviders(): Promise<AuthProvider[]> {
    const response = await fetch("/api/auth/providers");
    if (!response.ok) {
        throw new Error("Failed to fetch auth providers");
    }
    const data = await response.json();
    return data.providers || [];
}

export async function initOIDCClient(provider: AuthProvider) {
    const existing = userManagers.get(provider.id);
    if (existing) return existing;

    if (provider.type !== "oidc" || !provider.oidcIssuer || !provider.oidcClientId) {
        console.warn("[OIDC Client] OIDC provider not properly configured");
        return null;
    }

    // Fetch OIDC discovery document
    const discoveryResponse = await fetch(`${provider.oidcIssuer}/.well-known/openid-configuration`);
    const discoveryData = await discoveryResponse.json();

    // If discovery data is not present, abort — frontend should not fetch provider discovery directly (CORS)
    if (!discoveryData || !discoveryData.authorization_endpoint) {
        throw new Error('OIDC provider metadata not available in /api/auth/providers. Please ensure the backend returns discovery metadata for the provider to avoid CORS.');
    }

    console.log("[OIDC Client] Discovery data fetched (from providers endpoint):", {
        hasAuthEndpoint: !!discoveryData.authorization_endpoint,
        hasTokenEndpoint: !!discoveryData.token_endpoint
    });

    // Use provider-specific callback path to avoid needing to persist provider id across redirects
    const redirectUri = `${window.location.origin}/auth/callback/${encodeURIComponent(provider.id)}`;

    const userManager = new UserManager({
        authority: provider.oidcIssuer,
        client_id: provider.oidcClientId,
        redirect_uri: redirectUri,
        // Use Authorization Code Flow with PKCE (SPA) — manager will generate code_challenge and store code_verifier in storage
        response_type: 'code',
        scope: 'openid profile email',
        // Use localStorage instead of sessionStorage so state persists across redirects
        userStore: new WebStorageStateStore({ store: window.localStorage }),
        metadata: {
            issuer: provider.oidcIssuer,
            authorization_endpoint: discoveryData.authorization_endpoint,
            token_endpoint: discoveryData.token_endpoint,
            userinfo_endpoint: discoveryData.userinfo_endpoint,
            end_session_endpoint: discoveryData.end_session_endpoint,
            jwks_uri: discoveryData.jwks_uri,
        }
    });

    userManagers.set(provider.id, userManager);
    return userManager;
}

// Start login by letting the client (UserManager) generate PKCE and redirect to provider
export async function startOIDCLogin(provider: AuthProvider) {
    const manager = await initOIDCClient(provider);
    if (!manager) throw new Error("OIDC not configured");

    // manager.signinRedirect will create PKCE code_challenge, store code_verifier locally, and redirect browser
    await manager.signinRedirect();
}

export async function handleOIDCCallback(providerId: string): Promise<string> {
    const providers = await AUTH_PROVIDERS;
    const provider = providers.find(p => p.id === providerId);

    if (!provider) {
        throw new Error('OIDC provider id not found in callback URL');
    }

    if (!provider) throw new Error('No OIDC provider found');

    // Parse URL for code and state
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');

    if (error) throw new Error(`OIDC error: ${error}`);
    if (!code) throw new Error('No authorization code received');

    // Try to retrieve code_verifier from localStorage (oidc-client-ts stores state under 'oidc.' + state)
    let codeVerifier: string | null = null;
    if (state) {
        const stateKey = `oidc.${state}`;
        const stateData = localStorage.getItem(stateKey);
        if (stateData) {
            try {
                const parsed = JSON.parse(stateData);
                codeVerifier = parsed.code_verifier || null;
            } catch (e) {
                console.warn('[OIDC Client] Failed to parse state data:', e);
            }
        }
    }

    if (!codeVerifier) {
        console.warn('[OIDC Client] No code_verifier found; PKCE may not be used in server exchange');
    }

    // Exchange authorization code for Lidify token via backend (backend will perform token exchange with provider)
    const response = await fetch(`/api/auth/oidc/login/${encodeURIComponent(provider.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: provider.id, code, codeVerifier, redirectUri: `${window.location.origin}/auth/callback/${encodeURIComponent(provider.id)}`, state }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('[OIDC Client] Token exchange failed:', errorText);
        throw new Error(`Token exchange failed: ${response.status}`);
    }

    const { token } = await response.json();

    // Clean up stored PKCE/state
    try {
        if (state) localStorage.removeItem(`oidc.${state}`);
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (key.startsWith('oidc.')) {
                try { localStorage.removeItem(key); } catch (e) {}
            }
        }
    } catch (e) {
        // ignore cleanup errors
    }

    return token;
}
