"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface AIServicesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function AIServicesSection({ settings, onUpdate, onTest, isTesting }: AIServicesSectionProps) {
    const [fanartTestStatus, setFanartTestStatus] = useState<StatusType>("idle");
    const [fanartTestMessage, setFanartTestMessage] = useState("");
    const [lastfmTestStatus, setLastfmTestStatus] = useState<StatusType>("idle");
    const [lastfmTestMessage, setLastfmTestMessage] = useState("");

    const handleFanartTest = async () => {
        setFanartTestStatus("loading");
        setFanartTestMessage("Testing...");
        const result = await onTest("fanart");
        if (result.success) {
            setFanartTestStatus("success");
            setFanartTestMessage("Connected");
        } else {
            setFanartTestStatus("error");
            setFanartTestMessage(result.error || "Failed");
        }
    };

    const handleLastfmTest = async () => {
        setLastfmTestStatus("loading");
        setLastfmTestMessage("Testing...");
        const result = await onTest("lastfm");
        if (result.success) {
            setLastfmTestStatus("success");
            setLastfmTestMessage("Connected");
        } else {
            setLastfmTestStatus("error");
            setLastfmTestMessage(result.error || "Failed");
        }
    };

    return (
        <SettingsSection 
            id="ai-services" 
            title="Artwork Services"
            description="Enhance your library with high-quality artwork"
        >
            {/* Fanart.tv */}
            <SettingsRow 
                label="Enable Fanart.tv"
                description="Enhanced artist and album artwork"
                htmlFor="fanart-enabled"
            >
                <SettingsToggle
                    id="fanart-enabled"
                    checked={settings.fanartEnabled}
                    onChange={(checked) => onUpdate({ fanartEnabled: checked })}
                />
            </SettingsRow>

            {settings.fanartEnabled && (
                <>
                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.fanartApiKey}
                            onChange={(v) => onUpdate({ fanartApiKey: v })}
                            placeholder="Enter Fanart.tv API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleFanartTest}
                                disabled={isTesting || !settings.fanartApiKey}
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {fanartTestStatus === "loading" ? "Testing..." : "Test Connection"}
                            </button>
                            <InlineStatus
                                status={fanartTestStatus}
                                message={fanartTestMessage}
                                onClear={() => setFanartTestStatus("idle")}
                            />
                        </div>
                    </div>
                </>
            )}

            {/* Last.fm */}
            <div className="mt-6 pt-6 border-t border-white/5">
                <div className="mb-4">
                    <p className="text-sm text-white/60">
                        Last.fm is pre-configured with a default key. Add your own for higher rate limits.
                    </p>
                </div>
                
                <SettingsRow label="Last.fm API Key (Optional)">
                    <SettingsInput
                        type="password"
                        value={settings.lastfmApiKey || ""}
                        onChange={(v) => onUpdate({ lastfmApiKey: v })}
                        placeholder="Optional: Your Last.fm API key"
                        className="w-64"
                    />
                </SettingsRow>

                {settings.lastfmApiKey && (
                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleLastfmTest}
                                disabled={isTesting}
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {lastfmTestStatus === "loading" ? "Testing..." : "Test Connection"}
                            </button>
                            <InlineStatus
                                status={lastfmTestStatus}
                                message={lastfmTestMessage}
                                onClear={() => setLastfmTestStatus("idle")}
                            />
                        </div>
                    </div>
                )}
            </div>
        </SettingsSection>
    );
}
