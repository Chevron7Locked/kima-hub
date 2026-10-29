"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsToggle, SettingsSelect, ConnectionRows } from "../ui";
import { ConnectionTestResult, SystemSettings } from "../../types";
import { useConnectionTest } from "../../hooks/useConnectionTest";
import { api } from "@/lib/api";

interface LidarrProfile {
    id: number;
    name: string;
}

interface LidarrSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<ConnectionTestResult>;
    isTesting: boolean;
}

export function LidarrSection({ settings, onUpdate, onTest, isTesting }: LidarrSectionProps) {
    const [qualityProfiles, setQualityProfiles] = useState<LidarrProfile[]>([]);
    const [metadataProfiles, setMetadataProfiles] = useState<LidarrProfile[]>([]);
    const [profilesLoaded, setProfilesLoaded] = useState(false);

    const fetchProfiles = async () => {
        try {
            const data = await api.post("/system-settings/lidarr-profiles", {
                url: settings.lidarrUrl,
                apiKey: settings.lidarrApiKey,
            }) as { qualityProfiles?: LidarrProfile[]; metadataProfiles?: LidarrProfile[] };
            setQualityProfiles(data.qualityProfiles || []);
            setMetadataProfiles(data.metadataProfiles || []);
            setProfilesLoaded(true);
        } catch {
            setQualityProfiles([]);
            setMetadataProfiles([]);
        }
    };

    const connection = useConnectionTest(() => onTest("lidarr"), { onConnected: fetchProfiles });

    const hasProfiles = profilesLoaded && (qualityProfiles.length > 0 || metadataProfiles.length > 0);

    return (
        <SettingsSection
            id="lidarr"
            title="Download Services"
            description="Automate music downloads and library management"
        >
            <SettingsRow
                label="Enable Lidarr"
                description="Connect to Lidarr for music automation"
                htmlFor="lidarr-enabled"
            >
                <SettingsToggle
                    id="lidarr-enabled"
                    checked={settings.lidarrEnabled}
                    onChange={(checked) => onUpdate({ lidarrEnabled: checked })}
                />
            </SettingsRow>

            {settings.lidarrEnabled && (
                <>
                    <ConnectionRows
                        urlLabel="Lidarr URL"
                        url={settings.lidarrUrl}
                        onUrl={(v) => onUpdate({ lidarrUrl: v })}
                        urlPlaceholder="http://localhost:8686"
                        apiKey={settings.lidarrApiKey}
                        onApiKey={(v) => onUpdate({ lidarrApiKey: v })}
                        connection={connection}
                        isTesting={isTesting}
                    />

                    <SettingsRow
                        label="Remove junk downloads"
                        description="When a download has no usable music or is the wrong album, remove it so Lidarr tries the next release. Turn off if your own Lidarr setup already handles this"
                        htmlFor="lidarr-remove-junk"
                    >
                        <SettingsToggle
                            id="lidarr-remove-junk"
                            checked={settings.lidarrRemoveJunk}
                            onChange={(checked) => onUpdate({ lidarrRemoveJunk: checked })}
                        />
                    </SettingsRow>

                    {hasProfiles && (
                        <>
                            <SettingsRow
                                label="Quality Profile"
                                description="Quality profile for new artists. Default: the music folder's profile"
                            >
                                <SettingsSelect
                                    value={String(settings.lidarrQualityProfileId ?? "")}
                                    onChange={(v) => onUpdate({ lidarrQualityProfileId: v ? Number(v) : null })}
                                    options={[
                                        { value: "", label: "Lidarr's default" },
                                        ...qualityProfiles.map((p) => ({ value: String(p.id), label: p.name })),
                                    ]}
                                />
                            </SettingsRow>

                            <SettingsRow
                                label="Metadata Profile"
                                description="Metadata profile for new artists. Default: the music folder's profile"
                            >
                                <SettingsSelect
                                    value={String(settings.lidarrMetadataProfileId ?? "")}
                                    onChange={(v) => onUpdate({ lidarrMetadataProfileId: v ? Number(v) : null })}
                                    options={[
                                        { value: "", label: "Lidarr's default" },
                                        ...metadataProfiles.map((p) => ({ value: String(p.id), label: p.name })),
                                    ]}
                                />
                            </SettingsRow>
                        </>
                    )}
                </>
            )}
        </SettingsSection>
    );
}
