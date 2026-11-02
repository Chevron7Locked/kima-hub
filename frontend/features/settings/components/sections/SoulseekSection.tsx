"use client";

import { SettingsSection, SettingsRow, SettingsInput, SettingsSelect, ConnectionTestButton } from "../ui";
import { ConnectionTestResult, SystemSettings, soulseekConfigured } from "../../types";
import { useConnectionTest } from "../../hooks/useConnectionTest";
import { ExternalLink } from "lucide-react";

interface SoulseekSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<ConnectionTestResult>;
    isTesting: boolean;
}

export function SoulseekSection({ settings, onUpdate, onTest, isTesting }: SoulseekSectionProps) {
    const connection = useConnectionTest(() => onTest("soulseek"), {
        busy: "Connecting...",
        connected: () => "Connected to Soulseek",
        failed: "Connection failed",
    });

    const mode = settings.soulseekMode || "p2p";
    const isSlskd = mode === "slskd";
    const canTest = soulseekConfigured(settings);

    return (
        <SettingsSection
            id="soulseek"
            title="Soulseek"
            description="Configure Soulseek for music downloads — directly (P2P) or via an external slskd instance"
        >
            <SettingsRow
                label="Connection Mode"
                description={
                    isSlskd
                        ? "Use a slskd instance. Credentials stay in slskd."
                        : "Built-in client with your Soulseek account."
                }
            >
                <SettingsSelect
                    value={mode}
                    onChange={(v) => onUpdate({ soulseekMode: v as "p2p" | "slskd" })}
                    options={[
                        { value: "p2p", label: "Built-in (P2P)" },
                        { value: "slskd", label: "slskd (external)" },
                    ]}
                />
            </SettingsRow>

            {!isSlskd && (
                <>
                    <SettingsRow
                        label="Soulseek Username"
                        description={
                            <span className="flex items-center gap-1.5">
                                Your Soulseek account username
                                <a
                                    href="https://www.slsknet.org/news/node/1"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-brand hover:text-brand-hover transition-colors"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                    Create Account
                                </a>
                            </span>
                        }
                    >
                        <SettingsInput
                            value={settings.soulseekUsername || ""}
                            onChange={(v) => onUpdate({ soulseekUsername: v })}
                            placeholder="your_username"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Soulseek Password"
                        description="Your Soulseek account password"
                    >
                        <SettingsInput
                            type="password"
                            value={settings.soulseekPassword || ""}
                            onChange={(v) => onUpdate({ soulseekPassword: v })}
                            placeholder="your_password"
                            className="w-64"
                        />
                    </SettingsRow>
                </>
            )}

            {isSlskd && (
                <>
                    <SettingsRow
                        label="slskd URL"
                        description="Base URL of your slskd instance (e.g. http://slskd:5030)"
                    >
                        <SettingsInput
                            value={settings.slskdUrl || ""}
                            onChange={(v) => onUpdate({ slskdUrl: v })}
                            placeholder="http://slskd:5030"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="slskd API Key"
                        description="API key from your slskd configuration (leave blank if auth is disabled)"
                    >
                        <SettingsInput
                            type="password"
                            value={settings.slskdApiKey || ""}
                            onChange={(v) => onUpdate({ slskdApiKey: v })}
                            placeholder="optional"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="slskd download folder"
                        description="Where slskd's finished downloads appear inside Kima's container: the folder you mounted from slskd. Leave empty for /soulseek-downloads."
                    >
                        <SettingsInput
                            value={settings.soulseekDownloadPath || ""}
                            onChange={(v) => onUpdate({ soulseekDownloadPath: v })}
                            placeholder="/soulseek-downloads"
                            className="w-64"
                        />
                    </SettingsRow>
                </>
            )}

            <div className="pt-2 space-y-2">
                <ConnectionTestButton connection={connection} disabled={isTesting || !canTest} />
                <p className="text-xs text-[var(--text-muted)]">
                    Downloads will be saved to your Singles folder automatically
                </p>
            </div>
        </SettingsSection>
    );
}
