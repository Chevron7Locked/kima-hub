"use client";

import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { SystemSettings } from "../../types";

interface StoragePathsSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function StoragePathsSection({ settings, onUpdate }: StoragePathsSectionProps) {
    return (
        <SettingsSection
            id="storage"
            title="Storage"
            description="Configure storage paths for your music library"
        >
            <SettingsRow
                label="Server URL"
                description="Public base URL used by native app clients. Leave blank to auto-detect."
            >
                <SettingsInput
                    value={settings.publicUrl}
                    onChange={(v) => onUpdate({ publicUrl: v })}
                    placeholder="https://kima.example.com"
                    className="w-64"
                />
            </SettingsRow>

            <SettingsRow
                label="Music library path"
                description="Path to your music library"
            >
                <SettingsInput
                    value={settings.musicPath}
                    onChange={(v) => onUpdate({ musicPath: v })}
                    placeholder="/music"
                    className="w-64"
                />
            </SettingsRow>

            <SettingsRow 
                label="Download path"
                description="Path for new downloads"
            >
                <SettingsInput
                    value={settings.downloadPath}
                    onChange={(v) => onUpdate({ downloadPath: v })}
                    placeholder="/downloads"
                    className="w-64"
                />
            </SettingsRow>
        </SettingsSection>
    );
}
