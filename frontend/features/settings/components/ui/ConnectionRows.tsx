import { SettingsRow } from "./SettingsRow";
import { SettingsInput } from "./SettingsInput";
import { ConnectionTestButton } from "./ConnectionTestButton";
import type { useConnectionTest } from "../../hooks/useConnectionTest";

/** A service's address and API key, then the button that tests them; the test waits until both are filled in. */
export function ConnectionRows({
    urlLabel,
    url,
    onUrl,
    urlPlaceholder,
    apiKey,
    onApiKey,
    connection,
    isTesting,
}: {
    urlLabel: string;
    url: string;
    onUrl: (value: string) => void;
    urlPlaceholder: string;
    apiKey: string;
    onApiKey: (value: string) => void;
    connection: ReturnType<typeof useConnectionTest>;
    isTesting: boolean;
}) {
    return (
        <>
            <SettingsRow label={urlLabel}>
                <SettingsInput value={url} onChange={onUrl} placeholder={urlPlaceholder} className="w-64" />
            </SettingsRow>

            <SettingsRow label="API Key">
                <SettingsInput type="password" value={apiKey} onChange={onApiKey} placeholder="Enter API key" className="w-64" />
            </SettingsRow>

            <div className="pt-2">
                <ConnectionTestButton connection={connection} disabled={isTesting || !url || !apiKey} />
            </div>
        </>
    );
}
