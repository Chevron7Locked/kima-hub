"use client";

import { useMemo, useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";

interface SSOSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function SSOSection({ settings, onUpdate }: SSOSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Discovering…");
        try {
            const result = await api.testOidc(settings.oidcIssuer);
            if (result.success) {
                setTestStatus("success");
                setTestMessage(result.message || "Discovered");
            } else {
                setTestStatus("error");
                setTestMessage("Failed");
            }
        } catch (e: unknown) {
            setTestStatus("error");
            setTestMessage(e instanceof Error ? e.message : "Discovery failed");
        }
    };

    // The redirect URI the admin must register at the IdP. Prefer the configured
    // public URL; otherwise show the current origin. Derived during render.
    const redirectUri = useMemo(() => {
        const base = (settings.publicUrl || "").replace(/\/$/, "") ||
            (typeof window !== "undefined" ? window.location.origin : "");
        return `${base}/auth/callback`;
    }, [settings.publicUrl]);

    return (
        <SettingsSection
            id="sso"
            title="Single Sign-On (OIDC)"
            description="Let users sign in with an external identity provider (Authentik, Keycloak, etc.)"
        >
            <SettingsRow
                label="Enable SSO"
                description="Adds a 'Sign in with…' button. Local login stays available."
                htmlFor="oidc-enabled"
            >
                <SettingsToggle
                    id="oidc-enabled"
                    checked={settings.oidcEnabled}
                    onChange={(checked) => onUpdate({ oidcEnabled: checked })}
                />
            </SettingsRow>

            {settings.oidcEnabled && (
                <>
                    <SettingsRow
                        label="Provider Name"
                        description="Shown on the login button"
                    >
                        <SettingsInput
                            value={settings.oidcProviderName || ""}
                            onChange={(v) => onUpdate({ oidcProviderName: v })}
                            placeholder="SSO"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Issuer URL"
                        description="The provider's base URL (discovery is automatic)"
                    >
                        <SettingsInput
                            value={settings.oidcIssuer || ""}
                            onChange={(v) => onUpdate({ oidcIssuer: v })}
                            placeholder="https://auth.example.com/application/o/kima/"
                            className="w-80"
                        />
                    </SettingsRow>

                    <SettingsRow label="Client ID">
                        <SettingsInput
                            value={settings.oidcClientId || ""}
                            onChange={(v) => onUpdate({ oidcClientId: v })}
                            placeholder="Client ID"
                            className="w-80"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Client Secret"
                        description="Leave blank for a public (PKCE-only) client"
                    >
                        <SettingsInput
                            type="password"
                            value={settings.oidcClientSecret || ""}
                            onChange={(v) => onUpdate({ oidcClientSecret: v })}
                            placeholder="Client secret"
                            className="w-80"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Scopes"
                        description="Space-separated; must include openid"
                    >
                        <SettingsInput
                            value={settings.oidcScopes || ""}
                            onChange={(v) => onUpdate({ oidcScopes: v })}
                            placeholder="openid profile email"
                            className="w-80"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={testStatus === "loading" || !settings.oidcIssuer}
                                className="px-4 py-1.5 text-xs font-mono bg-white/5 border border-white/10 text-white/70 rounded-lg uppercase tracking-wider
                                    hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                {testStatus === "loading" ? "Testing…" : "Test Issuer"}
                            </button>
                            <InlineStatus
                                status={testStatus}
                                message={testMessage}
                                onClear={() => setTestStatus("idle")}
                            />
                        </div>
                    </div>

                    <div className="mt-4 pt-4 border-t border-white/5">
                        <p className="text-xs font-mono text-white/40 uppercase tracking-wider mb-3">
                            Account linking
                        </p>
                        <SettingsRow
                            label="Auto-link by username"
                            description="Bind SSO logins to an existing local account when the username matches. Disable if your IdP lets users pick arbitrary usernames (linking by verified email + subject still works)."
                            htmlFor="oidc-autolink-username"
                        >
                            <SettingsToggle
                                id="oidc-autolink-username"
                                checked={settings.oidcAutoLinkByUsername}
                                onChange={(checked) =>
                                    onUpdate({ oidcAutoLinkByUsername: checked })
                                }
                            />
                        </SettingsRow>
                    </div>

                    <div className="mt-4 pt-4 border-t border-white/5">
                        <p className="text-xs font-mono text-white/40 uppercase tracking-wider mb-3">
                            Role mapping (optional) — grant admin from a token claim
                        </p>
                        <SettingsRow
                            label="Role Claim"
                            description="Claim path holding roles/groups, e.g. groups or realm_access.roles"
                        >
                            <SettingsInput
                                value={settings.oidcRoleClaim || ""}
                                onChange={(v) => onUpdate({ oidcRoleClaim: v })}
                                placeholder="groups"
                                className="w-64"
                            />
                        </SettingsRow>
                        <SettingsRow
                            label="Admin Value"
                            description="If this value appears in the claim, the user becomes admin"
                        >
                            <SettingsInput
                                value={settings.oidcAdminValue || ""}
                                onChange={(v) => onUpdate({ oidcAdminValue: v })}
                                placeholder="kima-admins"
                                className="w-64"
                            />
                        </SettingsRow>
                    </div>

                    <div className="mt-4 pt-4 border-t border-white/5">
                        <p className="text-xs font-mono text-white/40 uppercase tracking-wider mb-1">
                            Redirect URI — register this at your provider
                        </p>
                        <code className="text-xs text-brand break-all">{redirectUri}</code>
                        {!settings.publicUrl && (
                            <p className="text-[10px] font-mono text-amber-400/70 uppercase tracking-wider mt-2">
                                ⚠ Set Public URL (Server section) so the redirect URI is
                                stable behind a proxy.
                            </p>
                        )}
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
