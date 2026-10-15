"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { Button } from "@/components/ui/Button";
import { copyText } from "@/lib/clipboard";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { usePublicConfig } from "@/hooks/useQueries";

interface ApiKey {
    id: string;
    name: string;
    createdAt: string;
    lastUsed: string | null;
}

export function SubsonicSection() {
    const { user } = useAuth();

    const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
    const [generating, setGenerating] = useState(false);
    const [newToken, setNewToken] = useState<string | null>(null);
    const [deviceName, setDeviceName] = useState("");
    const [status, setStatus] = useState<StatusType>("idle");
    const [message, setMessage] = useState("");
    const [revoking, setRevoking] = useState<string | null>(null);
    const config = usePublicConfig();
    const serverUrl = config.publicUrl || (config.loaded && typeof window !== "undefined" ? window.location.origin : "");

    useEffect(() => {
        loadApiKeys();
    }, []);

    const loadApiKeys = async () => {
        try {
            const data = await api.get<{ apiKeys: ApiKey[] }>("/api-keys");
            setApiKeys(data.apiKeys);
        } catch {
            // Non-fatal — keys list stays empty
        }
    };

    const handleGenerate = async () => {
        const name = deviceName.trim() || "Subsonic";
        setGenerating(true);
        setStatus("loading");
        setMessage("");
        setNewToken(null);
        try {
            const data = await api.post<{ apiKey: string }>("/api-keys", {
                deviceName: name,
            });
            setNewToken(data.apiKey);
            setStatus("success");
            setMessage("Token generated");
            await loadApiKeys();
        } catch (error: unknown) {
            setStatus("error");
            setMessage(error instanceof Error ? error.message : "Failed to generate token");
        } finally {
            setGenerating(false);
        }
    };

    const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);

    const handleRevoke = async (id: string) => {
        setRevoking(id);
        try {
            await api.delete(`/api-keys/${id}`);
            setApiKeys((prev) => prev.filter((k) => k.id !== id));
        } catch {
            setStatus("error");
            setMessage("Failed to revoke token");
        } finally {
            setRevoking(null);
        }
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
        });
    };

    return (
        <SettingsSection id="subsonic" title="Native Apps">
            <SettingsRow
                label="Server URL"
                description="Enter this in your Subsonic-compatible client. Admins can set a persistent URL in Storage settings."
            >
                <div className="flex items-center gap-2">
                    <span className="text-sm text-white bg-white/5 border border-white/10 px-3 py-2 rounded-lg tabular-nums break-all flex-1 min-w-0">
                        {serverUrl}
                    </span>
                    <button
                        onClick={() => void copyText(serverUrl)}
                        className="text-xs text-brand hover:text-brand-hover transition-colors shrink-0"
                    >
                        Copy
                    </button>
                </div>
            </SettingsRow>

            <SettingsRow
                label="Username"
                description="Use your Kima username in the client"
            >
                <span className="text-xs tabular-nums text-[var(--text-muted)]">
                    {user?.username}
                </span>
            </SettingsRow>

            <SettingsRow
                label="API Token"
                description="Generate a token to use as the password in your client"
            >
                <div className="flex flex-col gap-2">
                    <SettingsInput
                        value={deviceName}
                        onChange={setDeviceName}
                        placeholder="Client name (e.g. Amperfy, Symfonium, DSub)"
                    />
                    <div className="inline-flex items-center gap-3">
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={handleGenerate}
                            disabled={generating}
                        >
                            {generating ? "Generating..." : "Generate Token"}
                        </Button>
                        <InlineStatus
                            status={status}
                            message={message}
                            onClear={() => setStatus("idle")}
                        />
                    </div>
                </div>
            </SettingsRow>

            {newToken && (
                <div className="py-4 space-y-3 border-t border-b border-white/5">
                    <p className="text-xs text-warning">
                        Save this key — it won&apos;t be shown again.
                    </p>
                    <div className="flex items-start gap-2 min-w-0 overflow-hidden">
                        <code className="text-sm text-white bg-white/5 border border-white/10 px-3 py-2 rounded-lg font-mono break-all flex-1 min-w-0 overflow-hidden">
                            {newToken}
                        </code>
                        <button
                            onClick={() => void copyText(newToken)}
                            className="text-xs text-brand hover:text-brand-hover transition-colors shrink-0 pt-2"
                        >
                            Copy
                        </button>
                    </div>
                </div>
            )}

            {newToken && (
                <SettingsRow
                    label="Setup Guide"
                    description="How to connect your client"
                >
                    <div className="space-y-1 text-xs tabular-nums text-[var(--text-muted)]">
                        <p>1. Server URL — paste the URL above</p>
                        <p>2. Username — your Kima username</p>
                        <p>3. Password / API key — paste the token above</p>
                    </div>
                </SettingsRow>
            )}

            {apiKeys.length > 0 && (
                <SettingsRow
                    label="Active Tokens"
                    description="Revoke tokens to disconnect clients"
                >
                    <div className="space-y-2 w-full">
                        {apiKeys.map((key) => (
                            <div
                                key={key.id}
                                className="flex items-center justify-between gap-4 bg-white/5 border border-white/10 px-3 py-2 rounded-lg"
                            >
                                <div className="min-w-0">
                                    <p className="text-xs tabular-nums text-white truncate">{key.name}</p>
                                    <p className="text-xs tabular-nums text-[var(--text-muted)]">
                                        Created {formatDate(key.createdAt)}
                                        {key.lastUsed && ` · Last used ${formatDate(key.lastUsed)}`}
                                    </p>
                                </div>
                                <button
                                    onClick={() => setConfirmRevoke({ id: key.id, name: key.name })}
                                    disabled={revoking === key.id}
                                    className="text-xs tabular-nums text-danger-light hover:brightness-125 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {revoking === key.id ? "Revoking..." : "Revoke"}
                                </button>
                            </div>
                        ))}
                    </div>
                </SettingsRow>
            )}
            <ConfirmDialog
                isOpen={confirmRevoke !== null}
                onClose={() => setConfirmRevoke(null)}
                onConfirm={() => {
                    if (confirmRevoke) void handleRevoke(confirmRevoke.id);
                    setConfirmRevoke(null);
                }}
                title="Revoke this token?"
                message={`${confirmRevoke?.name ?? "This token"} stops working at once. The app using it needs a new token to connect again.`}
                confirmText="Revoke"
            />
        </SettingsSection>
    );
}
