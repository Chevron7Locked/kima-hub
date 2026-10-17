/**
 * AI provider adapters for the prompt→VibeQuery translation step.
 *
 * This is the only AI step in the feature. The LLM translates a free-text
 * prompt into explicit selection parameters (a JSON VibeQuery); track
 * selection is deterministic SQL (resolver.ts) and never involves the model.
 *
 * The interface is deliberately minimal: one chat completion that returns
 * JSON. OpenAI and any OpenAI-compatible /v1/chat/completions endpoint
 * (Ollama, LM Studio, vLLM, LocalAI, ...) all fit.
 */
import { UserFacingError } from "../../utils/errors";

export interface AIProviderConfig {
    provider: "openai" | "openai_compatible" | "none";
    apiBaseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
}

export interface AIProvider {
    readonly id: "openai" | "openai_compatible";
    readonly model: string;
    /** Translate a prompt into a VibeQuery, as a raw JSON string from the model. */
    translatePromptToVibeQuery(prompt: string, libraryContext: string): Promise<string>;
    /** A minimal chat roundtrip that verifies reachability and credentials. */
    testConnection(): Promise<void>;
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 600;

export function buildTranslationSystemPrompt(libraryContext: string): string {
    return `You convert a user's music-playlist request into explicit selection parameters for a personal music library. You never choose tracks — a deterministic database query does that from your parameters.

Respond with ONLY a JSON object. All fields are optional — omit any that the prompt does not imply:
- "valenceTarget": number 0.0-1.0, desired mood brightness (0.0 = dark/melancholic, 1.0 = bright/uplifting). Include only if the prompt implies a mood.
- "arousalTarget": number 0.0-1.0, desired energy (0.0 = calm/ambient, 1.0 = intense/high-energy). Include only if implied.
- "feelTolerance": number 0.25-3.0, how far tracks may sit from the feel target (standard deviations, 1.5 = default). Include only if the user asks for something loose or strict.
- "genreIncludes": array of genre names to include. Use EXACTLY the names from the library list below — never invent, translate, or guess names.
- "genreExcludes": array of genre names to exclude, same rules.
- "eraFrom": integer, earliest allowed album release year (within the library's range).
- "eraTo": integer, latest allowed album release year (within the library's range).
- "length": integer, number of tracks, 1-500. Include only if the user asks for a size.

If nothing in the prompt maps to any field, respond with exactly {}.

${libraryContext}`;
}

export class OpenAICompatibleProvider implements AIProvider {
    readonly id: "openai" | "openai_compatible";
    readonly model: string;
    private readonly baseUrl: string;
    private readonly apiKey: string | null;
    private readonly timeoutMs: number;

    constructor(opts: {
        id: "openai" | "openai_compatible";
        baseUrl: string;
        model: string;
        apiKey?: string | null;
        timeoutMs?: number;
    }) {
        this.id = opts.id;
        this.baseUrl = opts.baseUrl;
        this.model = opts.model;
        this.apiKey = opts.apiKey?.trim() || null;
        this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    async translatePromptToVibeQuery(prompt: string, libraryContext: string): Promise<string> {
        return this.chat(
            [
                {
                    role: "system",
                    content: buildTranslationSystemPrompt(libraryContext),
                },
                { role: "user", content: prompt },
            ],
            { json: true, maxTokens: MAX_OUTPUT_TOKENS },
        );
    }

    async testConnection(): Promise<void> {
        await this.chat([{ role: "user", content: "Reply with the single word: ok" }], {
            json: false,
            maxTokens: 8,
        });
    }

    /**
     * Raw /v1/chat/completions call. Some OpenAI-compatible servers reject the
     * `response_format` field outright — one retry without it keeps them usable.
     */
    private async chat(
        messages: { role: "system" | "user" | "assistant"; content: string }[],
        opts: { json: boolean; maxTokens: number },
    ): Promise<string> {
        const url = this.baseUrl.replace(/\/+$/, "") + "/chat/completions";
        const send = (withJsonFormat: boolean): Promise<Response> =>
            fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    temperature: 0,
                    max_tokens: opts.maxTokens,
                    ...(withJsonFormat ? { response_format: { type: "json_object" } } : {}),
                }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });

        let res: Response;
        try {
            res = await send(opts.json);
        } catch (error) {
            throw this.describeError(error);
        }

        if (!res.ok && res.status >= 400 && res.status < 500) {
            const text = await res.text().catch(() => "");
            if (opts.json && /response_format|json_object/i.test(text)) {
                res = await send(false);
            } else {
                throw new Error(
                    `AI provider error ${res.status}: ${this.redact(text.slice(0, 300))}`,
                );
            }
        }
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`AI provider error ${res.status}: ${this.redact(text.slice(0, 300))}`);
        }

        const data = (await res.json()) as {
            choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        if (!content) throw new Error("AI provider returned an empty completion");
        return content;
    }

    private describeError(error: unknown): Error {
        if (error instanceof Error && error.name === "TimeoutError") {
            return new Error(
                `AI provider request timed out after ${Math.round(this.timeoutMs / 1000)}s`,
            );
        }
        return new Error(
            `AI provider request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
    }

    /** Never echo the key back in a message (OpenAI reflects it in 401 bodies). */
    private redact(text: string): string {
        return this.apiKey && this.apiKey.length > 0 ? text.split(this.apiKey).join("***") : text;
    }
}

/**
 * Build a provider from the stored settings, or null when not (fully)
 * configured: OpenAI requires a key, an OpenAI-compatible endpoint requires a
 * base URL and a model (a key is optional — most local stacks have no auth).
 */
export function createAIProvider(config: AIProviderConfig): AIProvider | null {
    if (config.provider === "openai") {
        if (!config.apiKey?.trim()) return null;
        return new OpenAICompatibleProvider({
            id: "openai",
            baseUrl: OPENAI_BASE_URL,
            model: config.model?.trim() || OPENAI_DEFAULT_MODEL,
            apiKey: config.apiKey,
        });
    }
    if (config.provider === "openai_compatible") {
        const baseUrl = config.apiBaseUrl?.trim();
        const model = config.model?.trim();
        if (!baseUrl || !/^https?:\/\//i.test(baseUrl) || !model) return null;
        return new OpenAICompatibleProvider({
            id: "openai_compatible",
            baseUrl,
            model,
            apiKey: config.apiKey,
        });
    }
    return null;
}

/**
 * Extract the first balanced JSON object from a model response. Handles the
 * clean-JSON case (response_format=json_object), markdown code fences, and
 * prose around an object. Throws a 502 on garbage.
 */
export function extractJsonObject(raw: string): Record<string, unknown> {
    const text = raw.trim();
    const fenced = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
        throw new UserFacingError(
            "The AI provider did not return a usable selection query",
            502,
            "AI_BAD_RESPONSE",
        );
    }
    try {
        return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        throw new UserFacingError(
            "The AI provider returned malformed JSON",
            502,
            "AI_BAD_RESPONSE",
        );
    }
}
