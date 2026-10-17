/**
 * POST /api/ai-playlists/generate — AI-assisted playlist generation, Manual Mode
 * (#240, PR 1/3).
 *
 * The LLM's only job is translating a free-text prompt into explicit selection
 * parameters (a VibeQuery). Track selection is deterministic SQL (resolver.ts).
 *
 * The control principle is enforced structurally: a call that carries a `prompt`
 * is ALWAYS a dry run — it returns the normalized (editable) parameters plus a
 * track preview, never a playlist. Only a call that carries the user's final
 * `vibeQuery` (and `apply: true`) creates a playlist. There is no way for the
 * AI to decide what gets written without a user-reviewed parameter set in
 * between.
 */
import { Router } from "express";
import { z } from "zod";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { safeError, UserFacingError } from "../utils/errors";
import { resolveEncryptedSettings } from "../utils/encryptedFields";
import { parseStringArray } from "../utils/jsonArrays";
import { sessionLog } from "../utils/playlistLogger";
import * as playlistService from "../services/playlistService";
import { loadMatchingState } from "../services/matching/state";
import {
    buildLibraryContext,
    dedupLower,
    formatLibraryContext,
    normalizeVibeQuery,
    VIBE_QUERY_FIELDS,
} from "../services/ai/vibeQuery";
import { createAIProvider, extractJsonObject, type AIProviderConfig } from "../services/ai/providers";
import { resolveVibeQuery } from "../services/ai/resolver";

const router = Router();

router.use(requireAuthOrToken);

const aiGenerateBody = z.object({
    /** Free-text prompt; translated to parameters by the LLM. Implies a dry run. */
    prompt: z.string().trim().min(2).max(500).optional(),
    /** Explicit parameters (user-edited); resolves directly, may create on `apply`. */
    vibeQuery: z.record(z.unknown()).optional(),
    /** Playlist name for `apply` calls (defaults to "AI mix <date>"). */
    name: z.string().trim().min(1).max(200).optional(),
    /** Only honored for `vibeQuery` calls; `prompt` calls are always dry runs. */
    apply: z.boolean().optional(),
});

/**
 * Generate a playlist from a prompt (dry run) or from an explicit, user-
 * reviewed parameter set (`vibeQuery`, optionally creating a playlist with
 * `apply: true`).
 */
router.post("/generate", async (req, res) => {
    try {
        const body = aiGenerateBody.safeParse(req.body);
        if (!body.success) {
            const msg = body.error.issues
                .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
                .join("; ");
            return res.status(400).json({ error: `Invalid request body — ${msg}` });
        }
        const { prompt, vibeQuery, name, apply } = body.data;
        if (!prompt && !vibeQuery) {
            return res
                .status(400)
                .json({
                    error:
                        "Provide either a prompt (translated into editable parameters) or a vibeQuery (resolved directly).",
                });
        }

        const settingsRow = await prisma.systemSettings.findUnique({
            where: { id: "default" },
        });
        if (!settingsRow) {
            return res.status(400).json({ error: "No system settings exist yet." });
        }
        const settings = await resolveEncryptedSettings({ ...settingsRow });
        if (!settings.aiPlaylistEnabled) {
            return res
                .status(400)
                .json({ error: "AI playlist generation is disabled in the system settings." });
        }

        const state = await loadMatchingState();
        if (!state) {
            return res
                .status(400)
                .json({
                    error:
                        "The similarity step has not built the matching state yet; AI playlist generation needs it. Run the similarity step once and retry.",
                });
        }

        const libraryContext = await buildLibraryContext();

        // Merge order (the control principle): user-supplied parameters always
        // win; the LLM only fills what the user did not specify.
        const base: Record<string, unknown> = { ...(vibeQuery ?? {}) };
        let source: "llm" | "direct" = "direct";
        if (prompt) {
            const providerConfig: AIProviderConfig = {
                provider:
                    settings.aiProvider === "openai" || settings.aiProvider === "openai_compatible"
                        ? settings.aiProvider
                        : "none",
                apiBaseUrl: settings.aiApiBaseUrl,
                model: settings.aiModel,
                apiKey: settings.aiApiKey,
            };
            const provider = createAIProvider(providerConfig);
            if (!provider) {
                return res
                    .status(400)
                    .json({
                        error:
                            "No AI provider is configured. Set the provider, endpoint and credentials under Settings → AI.",
                    });
            }
            const raw = await provider.translatePromptToVibeQuery(
                prompt,
                formatLibraryContext(libraryContext),
            );
            const parsed = extractJsonObject(raw);
            for (const [key, value] of Object.entries(parsed)) {
                if ((VIBE_QUERY_FIELDS as readonly string[]).includes(key) && !(key in base)) {
                    base[key] = value;
                }
            }
            source = "llm";
        }

        // The global guardrail can only lower the requested length.
        const normalized = normalizeVibeQuery(base, {
            maxPlaylistSize: Math.max(1, settings.aiMaxPlaylistSize),
        }, { strict: !prompt });
        // Global guardrails (settings): appended to the user's excludes —
        // they always apply, even over what the user or the LLM asked for.
        normalized.genreExcludes = dedupLower([
            ...normalized.genreExcludes,
            ...parseStringArray(settings.aiBlockedGenres),
        ]);

        const tracks = await resolveVibeQuery(normalized, {
            state,
            excludeArtistNames: parseStringArray(settings.aiBlockedArtists),
        });

        // A prompt call is always a dry run: no playlist, no matter what
        // `apply` says. Only the user's final, reviewed parameter set creates.
        const wantApply = apply === true && !prompt;
        let playlistId: string | undefined;
        let playlistName: string | undefined;
        if (wantApply) {
            if (tracks.length === 0) {
                return res
                    .status(400)
                    .json({ error: "The query matched no library tracks; nothing to create." });
            }
            playlistName =
                name?.trim() || `AI mix ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
            const playlist = await prisma.playlist.create({
                data: { userId: req.user!.id, name: playlistName, isPublic: false },
            });
            const { added, rejected } = await playlistService.addTracks(
                playlist.id,
                tracks.map((t) => t.id),
            );
            if (rejected.length > 0) {
                logger.warn(
                    `ai-playlists: playlist ${playlist.id} created with ${added} tracks, ${rejected.length} rejected`,
                );
            }
            sessionLog(
                "ai-playlists",
                `Created "${playlistName}" (id ${playlist.id}) from ${source} vibe query ` +
                    `${JSON.stringify(normalized)} — ${added} tracks` +
                    (prompt ? ` (prompt: ${prompt})` : ""),
            );
            playlistId = playlist.id;
        }

        res.json({
            source,
            vibeQuery: normalized,
            libraryContext: {
                genres: libraryContext.genres.map((g) => g.name),
                yearRange: libraryContext.yearRange,
            },
            tracks: tracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                albumId: t.albumId,
                albumTitle: t.albumTitle,
                coverUrl: t.albumCoverUrl,
                artistId: t.artistId,
                artistName: t.artistName,
                year: t.year,
                feel: t.feel,
            })),
            trackCount: tracks.length,
            ...(playlistId ? { playlistId, playlistName } : {}),
        });
    } catch (error) {
        if (error instanceof UserFacingError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        // Provider-level failures (bad key, endpoint down, timeout, empty
        // completion) are upstream problems — 502 with a generic message,
        // without echoing the provider's response body to the client.
        if (error instanceof Error && error.message.startsWith("AI provider")) {
            return res
                .status(502)
                .json({
                    error:
                        "The AI provider rejected or failed the request. Check the AI provider settings in the system settings.",
                });
        }
        safeError(res, "POST /api/ai-playlists/generate", error);
    }
});

export default router;
