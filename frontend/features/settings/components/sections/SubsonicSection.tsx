"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow } from "../ui";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

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
    const [serverUrl, setServerUrl] = useState("");

    useEffect(() => {
        api.get<{ publicUrl: string }>("/system-settings/public-config")
            .then((data) => {
                setServerUrl(data.publicUrl || (typeof window !== "undefined" ? window.location.origin : ""));
            })
            .catch(() => {
                if (typeof window !== "undefined") {
                    setServerUrl(window.location.origin);
                }
            });

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

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
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
            {/* Connection Info */}
            <SettingsRow
                label="Server URL"
                description="Enter this in your Subsonic-compatible client. Admins can set a persistent URL in Storage settings."
            >
                <div className="flex items-center gap-2">
                    <span className="text-sm text-white bg-white/5 border border-white/10 px-3 py-2 rounded-lg font-mono break-all flex-1 min-w-0">
                        {serverUrl}
                    </span>
                    <button
                        onClick={() => copyToClipboard(serverUrl)}
                        className="text-xs font-mono text-[#fca208] hover:text-[#f97316] uppercase tracking-wider transition-colors shrink-0"
                    >
                        Copy
                    </button>
                </div>
            </SettingsRow>

            <SettingsRow
                label="Username"
                description="Use your Kima username in the client"
            >
                <span className="text-xs font-mono text-white/40 uppercase tracking-wider">
                    {user?.username}
                </span>
            </SettingsRow>

            {/* Token Generation */}
            <SettingsRow
                label="API Token"
                description="Generate a token to use as the password in your client"
            >
                <div className="flex flex-col gap-2">
                    <input
                        type="text"
                        value={deviceName}
                        onChange={(e) => setDeviceName(e.target.value)}
                        placeholder="Client name (e.g. Amperfy, Symfonium, DSub)"
                        className="text-sm text-white bg-white/5 border border-white/10 px-3 py-2 rounded-lg font-mono
                            placeholder:text-white/20 focus:outline-none focus:border-white/20 w-full"
                    />
                    <div className="inline-flex items-center gap-3">
                        <button
                            onClick={handleGenerate}
                            disabled={generating}
                            className="px-4 py-2 bg-[#fca208] text-black text-xs font-black rounded-lg uppercase tracking-wider
                                hover:bg-[#f97316] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {generating ? "Generating..." : "Generate Token"}
                        </button>
                        <InlineStatus
                            status={status}
                            message={message}
                            onClear={() => setStatus("idle")}
                        />
                    </div>
                </div>
            </SettingsRow>

            {/* Newly generated token display */}
            {newToken && (
                <div className="py-4 space-y-3 border-t border-b border-white/5">
                    <p className="text-xs font-mono text-[#f59e0b] uppercase tracking-wider">
                        Save this key — it won&apos;t be shown again.
                    </p>
                    <div className="flex items-start gap-2 min-w-0 overflow-hidden">
                        <code className="text-sm text-white bg-white/5 border border-white/10 px-3 py-2 rounded-lg font-mono break-all flex-1 min-w-0 overflow-hidden">
                            {newToken}
                        </code>
                        <button
                            onClick={() => copyToClipboard(newToken)}
                            className="text-xs font-mono text-[#fca208] hover:text-[#f97316] uppercase tracking-wider transition-colors shrink-0 pt-2"
                        >
                            Copy
                        </button>
                    </div>
                </div>
            )}

            {/* Setup guide — shown after a token has been generated */}
            {newToken && (
                <SettingsRow
                    label="Setup Guide"
                    description="How to connect your client"
                >
                    <div className="space-y-1 text-xs font-mono text-white/40 uppercase tracking-wider">
                        <p>1. Server URL — paste the URL above</p>
                        <p>2. Username — your Kima username</p>
                        <p>3. Password / API key — paste the token above</p>
                    </div>
                </SettingsRow>
            )}

            {/* Existing API keys */}
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
                                    <p className="text-xs font-mono text-white truncate">{key.name}</p>
                                    <p className="text-[10px] font-mono text-white/30 uppercase tracking-wider">
                                        Created {formatDate(key.createdAt)}
                                        {key.lastUsed && ` · Last used ${formatDate(key.lastUsed)}`}
                                    </p>
                                </div>
                                <button
                                    onClick={() => handleRevoke(key.id)}
                                    disabled={revoking === key.id}
                                    className="text-xs font-mono text-red-400 hover:text-red-300 uppercase tracking-wider transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {revoking === key.id ? "Revoking..." : "Revoke"}
                                </button>
                            </div>
                        ))}
                    </div>
                </SettingsRow>
            )}
        </SettingsSection>
    );
}
