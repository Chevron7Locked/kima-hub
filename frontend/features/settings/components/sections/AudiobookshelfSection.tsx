"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface AudiobookshelfSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function AudiobookshelfSection({ settings, onUpdate, onTest, isTesting }: AudiobookshelfSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Testing...");
        const result = await onTest("audiobookshelf");
        if (result.success) {
            setTestStatus("success");
            setTestMessage(result.version ? `v${result.version}` : "Connected");
        } else {
            setTestStatus("error");
            setTestMessage(result.error || "Failed");
        }
    };

    return (
        <SettingsSection
            id="audiobookshelf"
            title="Media Servers"
            description="Connect to external media servers for audiobooks and podcasts"
        >
            <SettingsRow
                label="Enable Audiobookshelf"
                description="Connect for audiobooks and podcasts"
                htmlFor="abs-enabled"
            >
                <SettingsToggle
                    id="abs-enabled"
                    checked={settings.audiobookshelfEnabled}
                    onChange={(checked) => onUpdate({ audiobookshelfEnabled: checked })}
                />
            </SettingsRow>

            {settings.audiobookshelfEnabled && (
                <>
                    <SettingsRow label="Server URL">
                        <SettingsInput
                            value={settings.audiobookshelfUrl}
                            onChange={(v) => onUpdate({ audiobookshelfUrl: v })}
                            placeholder="http://localhost:13378"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.audiobookshelfApiKey}
                            onChange={(v) => onUpdate({ audiobookshelfApiKey: v })}
                            placeholder="Enter API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={isTesting || !settings.audiobookshelfUrl || !settings.audiobookshelfApiKey}
                                className="px-4 py-1.5 text-xs tabular-nums bg-white/5 border border-white/10 text-[var(--text-secondary)] rounded-lg
                                    hover:bg-white/10 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                                {testStatus === "loading" ? "Testing..." : "Test Connection"}
                            </button>
                            <InlineStatus
                                status={testStatus}
                                message={testMessage}
                                onClear={() => setTestStatus("idle")}
                            />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
