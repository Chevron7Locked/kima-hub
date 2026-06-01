"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { SystemSettings } from "../../types";
import { ExternalLink } from "lucide-react";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface SoulseekSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function SoulseekSection({ settings, onUpdate, onTest, isTesting }: SoulseekSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Connecting...");
        const result = await onTest("soulseek");
        if (result.success) {
            setTestStatus("success");
            setTestMessage("Connected to Soulseek");
        } else {
            setTestStatus("error");
            setTestMessage(result.error || "Connection failed");
        }
    };

    const hasCredentials = settings.soulseekUsername && settings.soulseekPassword;

    return (
        <SettingsSection
            id="soulseek"
            title="Soulseek"
            description="Configure direct Soulseek connection for P2P music downloads"
        >
            <SettingsRow
                label="Soulseek Username"
                description={
                    <span className="flex items-center gap-1.5">
                        Your Soulseek account username
                        <a
                            href="https://www.slsknet.org/news/node/1"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-brand hover:text-[#f97316] transition-colors"
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

            <div className="pt-2 space-y-2">
                <div className="inline-flex items-center gap-3">
                    <button
                        onClick={handleTest}
                        disabled={isTesting || !hasCredentials}
                        className="px-4 py-1.5 text-xs font-mono bg-white/5 border border-white/10 text-white/70 rounded-lg uppercase tracking-wider
                            hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                        {testStatus === "loading" ? "Connecting..." : "Test Connection"}
                    </button>
                    <InlineStatus
                        status={testStatus}
                        message={testMessage}
                        onClear={() => setTestStatus("idle")}
                    />
                </div>
                <p className="text-xs text-white/40">
                    Downloads will be saved to your Singles folder automatically
                </p>
            </div>
        </SettingsSection>
    );
}
