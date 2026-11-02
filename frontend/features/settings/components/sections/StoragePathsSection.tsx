"use client";

import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";

interface StoragePathsSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function StoragePathsSection({ settings, onUpdate }: StoragePathsSectionProps) {
    return (
        <SettingsSection
            id="storage"
            title="Address and storage"
            description="Where Kima is reached, where your music lives, and whether Kima checks for updates"
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
                label="Check for updates"
                description="One anonymous request per day to github releases, so the version badge can flag a newer server. off suits installs without internet."
            >
                <SettingsToggle
                    id="update-checks"
                    checked={settings.updateChecksEnabled}
                    onChange={(checked) => onUpdate({ updateChecksEnabled: checked })}
                />
            </SettingsRow>

            <SettingsRow
                label="Music library path"
                description={
                    settings.musicPathFixedByEnv
                        ? <>Set by the server&apos;s <span className="font-mono">MUSIC_PATH</span>. Scans and downloads both use this folder.</>
                        : "The folder Kima scans and downloads into, as the server sees it. A change applies on save."
                }
            >
                <SettingsInput
                    value={settings.musicPath}
                    onChange={(v) => onUpdate({ musicPath: v })}
                    placeholder="/music"
                    className="w-64"
                    disabled={settings.musicPathFixedByEnv}
                />
            </SettingsRow>

        </SettingsSection>
    );
}
