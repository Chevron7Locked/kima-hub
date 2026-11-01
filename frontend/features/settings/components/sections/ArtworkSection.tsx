"use client";

import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle, ConnectionTestButton } from "../ui";
import { ConnectionTestResult, SystemSettings } from "../../types";
import { useConnectionTest } from "../../hooks/useConnectionTest";

interface ArtworkSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<ConnectionTestResult>;
    isTesting: boolean;
}

export function ArtworkSection({ settings, onUpdate, onTest, isTesting }: ArtworkSectionProps) {
    const fanartTest = useConnectionTest(() => onTest("fanart"), { connected: () => "Connected" });

    return (
        <SettingsSection
            id="artwork"
            title="Artwork"
            description="Enhance your library with high-quality artwork"
        >
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
                        <ConnectionTestButton connection={fanartTest} disabled={isTesting || !settings.fanartApiKey} />
                    </div>
                </>
            )}

            <div className="mt-6 pt-6 border-t border-white/5">
                <div className="mb-4">
                    <p className="text-xs text-[var(--text-muted)]">
                        AcoustID identifies tracks by their audio fingerprint. Add your own API key for higher rate limits.
                    </p>
                </div>

                <SettingsRow label="AcoustID API Key (Optional)">
                    <SettingsInput
                        type="password"
                        value={settings.acoustidApiKey || ""}
                        onChange={(v) => onUpdate({ acoustidApiKey: v })}
                        placeholder="Your AcoustID key (optional)"
                        className="w-64"
                    />
                </SettingsRow>
            </div>
        </SettingsSection>
    );
}
