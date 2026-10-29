"use client";

import { SettingsSection, SettingsRow, SettingsToggle, ConnectionRows } from "../ui";
import { ConnectionTestResult, SystemSettings } from "../../types";
import { useConnectionTest } from "../../hooks/useConnectionTest";

interface AudiobookshelfSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<ConnectionTestResult>;
    isTesting: boolean;
}

export function AudiobookshelfSection({ settings, onUpdate, onTest, isTesting }: AudiobookshelfSectionProps) {
    const connection = useConnectionTest(() => onTest("audiobookshelf"));

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
                    <ConnectionRows
                        urlLabel="Server URL"
                        url={settings.audiobookshelfUrl}
                        onUrl={(v) => onUpdate({ audiobookshelfUrl: v })}
                        urlPlaceholder="http://localhost:13378"
                        apiKey={settings.audiobookshelfApiKey}
                        onApiKey={(v) => onUpdate({ audiobookshelfApiKey: v })}
                        connection={connection}
                        isTesting={isTesting}
                    />
                </>
            )}
        </SettingsSection>
    );
}
