/**
 * OIDC / SSO service — Authorization Code flow with PKCE (S256).
 *
 * Security model:
 *  - The client secret and the PKCE code_verifier never leave the server.
 *  - The id_token signature is verified against the provider's JWKS (handled by
 *    openid-client's client.callback()), along with iss / aud / exp / nonce.
 *  - state + nonce + code_verifier are stored server-side in Redis keyed by an
 *    opaque state value with a short TTL, so the callback can't be replayed or
 *    forged.
 *
 * Config lives in SystemSettings (DB), edited via the Settings UI.
 */

// Type-only import: openid-client is loaded lazily (dynamic import) inside the
// methods below so importing this module — and the auth router that uses it —
// doesn't eagerly pull openid-client at load time (it breaks Jest's ESM
// interop and isn't needed unless OIDC is actually exercised).
import type { Client, TokenSet } from "openid-client";
import { logger } from "../utils/logger";
import { getSystemSettings } from "../utils/systemSettings";

const FLOW_TTL_SECONDS = 600; // 10 minutes to complete a login
const REDIS_PREFIX = "oidc:flow:";

export interface OidcClaims {
    sub: string;
    email?: string;
    emailVerified?: boolean;
    preferredUsername?: string;
    /** Raw value of the configured role claim, if any. */
    roleValue?: unknown;
}

interface FlowState {
    codeVerifier: string;
    nonce: string;
    redirectUri: string;
}

class OidcService {
    private cachedClient: Client | null = null;
    private cacheKey: string | null = null;

    /** Public, non-sensitive provider info for the login screen. */
    async getProviderInfo(): Promise<{ enabled: boolean; name: string } | null> {
        const s = await getSystemSettings();
        if (!s?.oidcEnabled || !s?.oidcIssuer || !s?.oidcClientId) return null;
        return { enabled: true, name: s.oidcProviderName || "SSO" };
    }

    /** True when OIDC is fully configured and enabled. */
    async isEnabled(): Promise<boolean> {
        return (await this.getProviderInfo()) !== null;
    }

    /** Drop the cached discovery client (call when settings change). */
    reset(): void {
        this.cachedClient = null;
        this.cacheKey = null;
    }

    /**
     * Build (or reuse) the openid-client Client from current settings. Discovery
     * is cached and only re-run when issuer/clientId/secret/scopes change.
     */
    private async getClient(redirectUri: string): Promise<Client> {
        const s = await getSystemSettings();
        if (!s?.oidcEnabled || !s?.oidcIssuer || !s?.oidcClientId) {
            throw new Error("OIDC is not configured");
        }
        const secret = s.oidcClientSecret || "";
        const key = `${s.oidcIssuer}|${s.oidcClientId}|${secret ? "conf" : "pub"}|${redirectUri}`;
        if (this.cachedClient && this.cacheKey === key) return this.cachedClient;

        const { Issuer } = await import("openid-client");
        const issuer = await Issuer.discover(s.oidcIssuer);
        const client = new issuer.Client({
            client_id: s.oidcClientId,
            client_secret: secret || undefined,
            redirect_uris: [redirectUri],
            response_types: ["code"],
            // Confidential client when a secret is present, public (PKCE-only) otherwise.
            token_endpoint_auth_method: secret ? "client_secret_basic" : "none",
        });
        this.cachedClient = client;
        this.cacheKey = key;
        logger.debug(`[OIDC] Discovery client built for issuer ${s.oidcIssuer}`);
        return client;
    }

    private scopeString(scopes?: string | null): string {
        const s = (scopes || "openid profile email").trim();
        // Always require openid.
        return s.includes("openid") ? s : `openid ${s}`;
    }

    /**
     * Begin a login: generate PKCE + state + nonce, persist them server-side,
     * and return the provider authorization URL for the browser to follow.
     */
    async startLogin(
        redirectUri: string,
    ): Promise<{ authorizationUrl: string; state: string }> {
        const settings = await getSystemSettings();
        const client = await this.getClient(redirectUri);

        const { generators } = await import("openid-client");
        const state = generators.state();
        const nonce = generators.nonce();
        const codeVerifier = generators.codeVerifier();
        const codeChallenge = generators.codeChallenge(codeVerifier);

        const flow: FlowState = { codeVerifier, nonce, redirectUri };
        const { redisClient } = await import("../utils/redis");
        await redisClient.setex(
            REDIS_PREFIX + state,
            FLOW_TTL_SECONDS,
            JSON.stringify(flow),
        );

        const authorizationUrl = client.authorizationUrl({
            scope: this.scopeString(settings?.oidcScopes),
            state,
            nonce,
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
            redirect_uri: redirectUri,
        });

        return { authorizationUrl, state };
    }

    /**
     * Complete a login: look up the stored flow by state, exchange the code with
     * PKCE, verify the id_token, and return the validated claims. The flow entry
     * is single-use (deleted on lookup) to prevent replay.
     */
    async handleCallback(params: {
        code?: string;
        state?: string;
        error?: string;
        error_description?: string;
    }): Promise<OidcClaims> {
        if (params.error) {
            throw new Error(
                `Provider returned error: ${params.error}${
                    params.error_description ? ` (${params.error_description})` : ""
                }`,
            );
        }
        if (!params.state || !params.code) {
            throw new Error("Missing code or state");
        }

        const redisKey = REDIS_PREFIX + params.state;
        const { redisClient } = await import("../utils/redis");
        const raw = await redisClient.get(redisKey);
        if (!raw) {
            throw new Error("Login session expired or invalid — please retry");
        }
        // Single-use: delete immediately so a replayed callback can't reuse it.
        await redisClient.del(redisKey);
        const flow: FlowState = JSON.parse(raw);

        const client = await this.getClient(flow.redirectUri);
        let tokenSet: TokenSet;
        try {
            tokenSet = await client.callback(
                flow.redirectUri,
                { code: params.code, state: params.state },
                { code_verifier: flow.codeVerifier, nonce: flow.nonce, state: params.state },
            );
        } catch (err: any) {
            logger.warn(`[OIDC] Token exchange/verification failed: ${err.message}`);
            throw new Error("Token verification failed");
        }

        // claims() returns the verified id_token claims. The id_token sub is the
        // authoritative identity — it must not be overridden by userinfo.
        const claims = tokenSet.claims();
        const idSub = claims.sub;
        if (!idSub) throw new Error("Provider did not return a subject (sub)");
        let merged: Record<string, any> = { ...claims };

        // Pull additional claims from userinfo when present (some providers keep
        // groups/email out of the id_token). Per OIDC §5.3.2 the userinfo sub
        // MUST equal the id_token sub — a mismatch is a security failure, not a
        // soft "skip". A network/other error fetching userinfo is non-fatal.
        if (tokenSet.access_token) {
            let userinfo: Record<string, any> | null = null;
            try {
                userinfo = (await client.userinfo(tokenSet.access_token)) as Record<
                    string,
                    any
                >;
            } catch (err: any) {
                logger.debug(`[OIDC] userinfo fetch skipped: ${err.message}`);
            }
            if (userinfo) {
                if (userinfo.sub && userinfo.sub !== idSub) {
                    logger.warn("[OIDC] userinfo sub does not match id_token sub");
                    throw new Error("Token verification failed");
                }
                // id_token sub stays authoritative regardless of merge order.
                merged = { ...merged, ...userinfo, sub: idSub };
            }
        }

        const settings = await getSystemSettings();
        const roleClaim = settings?.oidcRoleClaim?.trim();
        const roleValue = roleClaim ? this.readClaimPath(merged, roleClaim) : undefined;

        return {
            sub: String(merged.sub),
            email: merged.email ? String(merged.email) : undefined,
            emailVerified:
                typeof merged.email_verified === "boolean"
                    ? merged.email_verified
                    : undefined,
            preferredUsername: merged.preferred_username
                ? String(merged.preferred_username)
                : undefined,
            roleValue,
        };
    }

    /**
     * Verify an issuer URL by running OIDC discovery against it. Used by the
     * settings "Test" button so an admin can confirm the issuer before saving.
     */
    async testIssuer(issuerUrl: string): Promise<{
        issuer: string;
        authorizationEndpoint?: string;
        tokenEndpoint?: string;
        jwksUri?: string;
    }> {
        const { Issuer } = await import("openid-client");
        const issuer = await Issuer.discover(issuerUrl);
        return {
            issuer: issuer.metadata.issuer,
            authorizationEndpoint: issuer.metadata.authorization_endpoint,
            tokenEndpoint: issuer.metadata.token_endpoint,
            jwksUri: issuer.metadata.jwks_uri,
        };
    }

    /** Read a possibly-nested claim by dot path (e.g. "realm_access.roles"). */
    private readClaimPath(obj: Record<string, any>, path: string): unknown {
        return path
            .split(".")
            .reduce<any>((acc, key) => (acc == null ? acc : acc[key]), obj);
    }
}

export const oidcService = new OidcService();
