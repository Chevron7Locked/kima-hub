"use client";

import { SettingsSection, SettingsRow, SettingsInput, SettingsSelect, SettingsToggle, ConnectionTestButton } from "../ui";
import { ConnectionTestResult, SystemSettings } from "../../types";
import { useConnectionTest } from "../../hooks/useConnectionTest";

interface AiSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<ConnectionTestResult>;
    isTesting: boolean;
}

/**
 * AI playlist generation (#240, Manual Mode). The model only translates a
 * prompt into explicit selection parameters — the user reviews and edits them
 * before anything is created, and track selection stays deterministic.
 */
export function AiSection({ settings, onUpdate, onTest, isTesting }: AiSectionProps) {
    const provider = settings.aiProvider;
    const canTest =
        settings.aiPlaylistEnabled &&
        provider !== "none" &&
        (provider === "openai"
            ? !!settings.aiApiKey?.trim()
            : !!(settings.aiApiBaseUrl?.trim() && settings.aiModel?.trim()));

    // Tests the candidate values currently in the form, not the saved ones.
    const connection = useConnectionTest(() => onTest("ai"));

    // The blocked lists are string[] in state, edited as comma-separated text.
    const splitList = (value: string): string[] =>
        value.split(",").map((term) => term.trim()).filter((term) => term.length > 0);

    return (
        <SettingsSection
            id="ai"
            title="AI Playlists"
            description="Generate playlists from free-text prompts. The model only picks the selection parameters — you review and edit them before a playlist is created, and track selection stays deterministic."
        >
            <SettingsRow
                label="Enable AI playlist generation"
                description="When off, the generation endpoint refuses all requests."
            >
                <SettingsToggle
                    checked={settings.aiPlaylistEnabled}
                    onChange={(enabled) => onUpdate({ aiPlaylistEnabled: enabled })}
                />
            </SettingsRow>

            {settings.aiPlaylistEnabled && (
                <>
                    <SettingsRow
                        label="Provider"
                        description="Any OpenAI-compatible endpoint works (Ollama, vLLM, LM Studio, …). The key and prompt parameters stay on your server."
                    >
                        <SettingsSelect
                            value={provider}
                            options={[
                                { value: "openai", label: "OpenAI" },
                                { value: "openai_compatible", label: "OpenAI-compatible" },
                                { value: "none", label: "None — generation disabled" },
                            ]}
                            onChange={(value) =>
                                onUpdate({ aiProvider: value as SystemSettings["aiProvider"] })
                            }
                        />
                    </SettingsRow>

                    {provider === "openai" && (
                        <SettingsRow
                            label="API key"
                            description="Stored encrypted at rest; never sent to the model."
                        >
                            <SettingsInput
                                type="password"
                                value={settings.aiApiKey ?? ""}
                                onChange={(value) => onUpdate({ aiApiKey: value || null })}
                                placeholder="sk-…"
                            />
                        </SettingsRow>
                    )}

                    {provider === "openai_compatible" && (
                        <>
                            <SettingsRow
                                label="Endpoint URL"
                                description="Base URL of an OpenAI-compatible /v1 API."
                            >
                                <SettingsInput
                                    type="url"
                                    value={settings.aiApiBaseUrl ?? ""}
                                    onChange={(value) =>
                                        onUpdate({ aiApiBaseUrl: value.trim() ? value : null })
                                    }
                                    placeholder="https://llm.example.local:1234/v1"
                                />
                            </SettingsRow>

                            <SettingsRow
                                label="Model name"
                                description="Exactly the name the endpoint expects."
                            >
                                <SettingsInput
                                    value={settings.aiModel ?? ""}
                                    onChange={(value) => onUpdate({ aiModel: value || null })}
                                    placeholder="e.g. qwen2.5:14b"
                                />
                            </SettingsRow>

                            <SettingsRow
                                label="API key"
                                description="Optional for self-hosted endpoints; stored encrypted when set."
                            >
                                <SettingsInput
                                    type="password"
                                    value={settings.aiApiKey ?? ""}
                                    onChange={(value) => onUpdate({ aiApiKey: value || null })}
                                    placeholder="Leave empty if not required"
                                />
                            </SettingsRow>
                        </>
                    )}

                    {provider !== "none" && (
                        <SettingsRow
                            label="Connection"
                            description="Tests the values in this form — nothing is saved by testing."
                        >
                            <ConnectionTestButton connection={connection} disabled={isTesting || !canTest} />
                        </SettingsRow>
                    )}

                    <SettingsRow
                        label="Max playlist size"
                        description="Hard ceiling for a single generation (1–1000). The LLM and the user can only ask for less."
                    >
                        <SettingsInput
                            type="number"
                            value={String(settings.aiMaxPlaylistSize)}
                            onChange={(value) => {
                                const n = parseInt(value, 10);
                                if (!Number.isNaN(n)) {
                                    onUpdate({ aiMaxPlaylistSize: Math.max(1, Math.min(1000, n)) });
                                }
                            }}
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Blocked genres"
                        description="Global guardrail, comma-separated: applied to every AI-generated playlist, on top of whatever the prompt or the user asks for."
                    >
                        <SettingsInput
                            value={settings.aiBlockedGenres.join(", ")}
                            onChange={(value) => onUpdate({ aiBlockedGenres: splitList(value) })}
                            placeholder="e.g. classical, ambient"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Blocked artists"
                        description="Global guardrail, comma-separated: these artists are excluded from every AI-generated playlist."
                    >
                        <SettingsInput
                            value={settings.aiBlockedArtists.join(", ")}
                            onChange={(value) => onUpdate({ aiBlockedArtists: splitList(value) })}
                            placeholder="e.g. Artist A, Artist B"
                        />
                    </SettingsRow>
                </>
            )}
        </SettingsSection>
    );
}
