import { Router } from "express";
import axios from "axios";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { z } from "zod";
import { writeEnvFile } from "../utils/envWriter";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";
import {
    decryptOrNull,
    encryptSettings,
    resolveEncryptedSettings,
} from "../utils/encryptedFields";
import {
    getGpuStatus,
    setGpuToggles,
    gpuSupported,
} from "../services/gpuRuntime";
import { configureLidarrWebhook } from "../services/lidarrWebhookSetup";
import { createLidarrClient } from "../services/lidarrClient";
import { safeError, UserFacingError } from "../utils/errors";
import { parseStringArray, stringifyStringArray } from "../utils/jsonArrays";

const router = Router();

// Public (any authenticated user) — returns only the configured server URL
router.get("/public-config", requireAuth, async (_req, res) => {
  try {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: "default" },
      select: { publicUrl: true },
    });
    res.json({ publicUrl: settings?.publicUrl || "" });
  } catch (error) {
    logger.error("Get public config error:", error);
    res.status(500).json({ error: "Failed to get server config" });
  }
});

// Only admins can access system settings (requireAdmin includes auth check)
router.use(requireAdmin);

const systemSettingsSchema = z.object({
  // Download Services
  lidarrEnabled: z.boolean().optional(),
  lidarrUrl: z.string().optional(),
  lidarrApiKey: z.string().nullable().optional(),
  lidarrWebhookSecret: z.string().nullable().optional(),
  lidarrQualityProfileId: z.number().int().positive().nullable().optional(),
  lidarrMetadataProfileId: z.number().int().positive().nullable().optional(),
  lidarrRemoveJunk: z.boolean().optional(),

  fanartEnabled: z.boolean().optional(),
  fanartApiKey: z.string().nullable().optional(),
  acoustidApiKey: z.string().nullable().optional(),

  // Media Services
  audiobookshelfEnabled: z.boolean().optional(),
  audiobookshelfUrl: z.string().optional(),
  audiobookshelfApiKey: z.string().nullable().optional(),

  // Soulseek (direct connection via vendored soulseek-ts)
  soulseekUsername: z.string().nullable().optional(),
  soulseekPassword: z.string().nullable().optional(),
  soulseekEnabled: z.boolean().nullable().optional(),
  soulseekDownloadPath: z.string().nullable().optional(),

  // Soulseek backend: "p2p" = built-in client (needs the credentials above),
  // "slskd" = route via a slskd REST instance (which holds its own account).
  soulseekMode: z.enum(["p2p", "slskd"]).nullable().optional(),
  // Pin to an http(s) URL so a file:// or scheme-less internal address can't be
  // saved (admin-only, but slskd-client.ts trusts this value for the request).
  slskdUrl: z
    .union([
      z
        .string()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), {
          message: "slskdUrl must start with http:// or https://",
        }),
      z.literal(""),
    ])
    .nullable()
    .optional(),
  slskdApiKey: z.string().nullable().optional(),

  // Spotify (for playlist import)
  spotifyClientId: z.string().nullable().optional(),
  spotifyClientSecret: z.string().nullable().optional(),


  // Storage Paths
  musicPath: z.string().optional(),
  downloadPath: z.string().optional(),

  // Feature Flags
  autoSync: z.boolean().optional(),
  autoEnrichMetadata: z.boolean().optional(),

  // Advanced Settings
  transcodeCacheMaxGb: z.number().optional(),
  maxQueueLength: z.number().int().min(100).max(100000).optional(),
  soulseekConcurrentDownloads: z.number().min(1).max(10).optional(),

  // Download Preferences
  downloadSource: z.enum(["soulseek", "lidarr"]).optional(),
  primaryFailureFallback: z.enum(["none", "lidarr", "soulseek"]).optional(),

  // Server
  publicUrl: z.union([z.string().url(), z.literal("")]).optional(),
  registrationOpen: z.boolean().optional(),

  // AI playlists (#240, Manual Mode): off by default. The LLM only
  // translates a free-text prompt into selection parameters; track selection
  // stays deterministic SQL (services/ai). The API key is stored encrypted.
  aiPlaylistEnabled: z.boolean().optional(),
  aiProvider: z.enum(["openai", "openai_compatible", "none"]).optional(),
  aiApiBaseUrl: z
    .union([
      z
        .string()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), {
          message: "aiApiBaseUrl must start with http:// or https://",
        }),
      z.literal(""),
    ])
    .nullable()
    .optional(),
  aiModel: z.string().nullable().optional(),
  aiApiKey: z.string().nullable().optional(),
  aiMaxPlaylistSize: z.number().int().min(1).max(1000).optional(),
  // Global guardrails, applied to every AI-generated playlist regardless of
  // what the prompt or the user's parameters ask for. Stored as JSON arrays
  // in TEXT columns (prisma String?), validated here as string[].
  aiBlockedGenres: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  aiBlockedArtists: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
});

// GET /system-settings
router.get("/", async (_req, res) => {
  try {
    let settings = await prisma.systemSettings.findUnique({
      where: { id: "default" },
    });

    // Create default settings if they don't exist
    if (!settings) {
      settings = await prisma.systemSettings.create({
        data: {
          id: "default",
          lidarrEnabled: true,
          lidarrUrl: "http://localhost:8686",
          fanartEnabled: false,
          audiobookshelfEnabled: false,
          audiobookshelfUrl: "http://localhost:13378",
          musicPath: "/music",
          downloadPath: "/downloads",
          autoSync: true,
          autoEnrichMetadata: true,
          transcodeCacheMaxGb: 10,
          maxQueueLength: 10000,
          soulseekConcurrentDownloads: 4,
        },
      });
    }

    // Decrypt every field in ENCRYPTED_FIELDS before sending to the client.
    const resolved = await resolveEncryptedSettings({ ...settings });

    // The AI guardrail lists are stored as JSON strings (prisma String?);
    // the client always deals in string[] and sends string[] back on save.
    const resolvedAny = resolved as Record<string, unknown>;
    res.json({
      ...resolved,
      aiBlockedGenres: parseStringArray(resolvedAny.aiBlockedGenres),
      aiBlockedArtists: parseStringArray(resolvedAny.aiBlockedArtists),
    });
  } catch (error) {
    logger.error("Get system settings error:", error);
    res.status(500).json({ error: "Failed to get system settings" });
  }
});

// POST /system-settings
router.post("/", async (req, res) => {
  try {
    const data = systemSettingsSchema.parse(req.body);

    // The AI guardrail lists are validated as string[] above and stored as
    // JSON strings (prisma String?) — serialize before the upsert.
    const mutableData = data as Record<string, unknown>;
    if (mutableData.aiBlockedGenres !== undefined) {
      mutableData.aiBlockedGenres = stringifyStringArray(
        mutableData.aiBlockedGenres as string[],
      );
    }
    if (mutableData.aiBlockedArtists !== undefined) {
      mutableData.aiBlockedArtists = stringifyStringArray(
        mutableData.aiBlockedArtists as string[],
      );
    }

    logger.debug("[SYSTEM SETTINGS] Saving settings...");
    logger.debug(
      "[SYSTEM SETTINGS] transcodeCacheMaxGb:",
      data.transcodeCacheMaxGb,
    );

    // Encrypt every supplied field from ENCRYPTED_FIELDS; fields the
    // payload omits stay untouched by the upsert.
    const encryptedData = encryptSettings(data as Record<string, unknown>) as any;

    // Fetch existing settings before save to detect credential changes
    const existingSettings = await prisma.systemSettings.findUnique({ where: { id: "default" } });

    await prisma.systemSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        ...encryptedData,
      },
      update: encryptedData,
    });

    invalidateSystemSettingsCache();

    // Reconnect Soulseek only when a connection setting actually changed: the P2P
    // credentials or the slskd backend (mode, URL, API key).
    if (
      data.soulseekUsername !== undefined ||
      data.soulseekPassword !== undefined ||
      data.soulseekMode !== undefined ||
      data.slskdUrl !== undefined ||
      data.slskdApiKey !== undefined
    ) {
      try {
        const oldUsername = existingSettings?.soulseekUsername || "";
        const oldPassword = decryptOrNull("soulseekPassword", existingSettings?.soulseekPassword) ?? "";
        const newUsername = data.soulseekUsername !== undefined ? data.soulseekUsername : oldUsername;
        const newPassword = data.soulseekPassword !== undefined ? data.soulseekPassword : oldPassword;

        const oldMode = existingSettings?.soulseekMode || "";
        const newMode = (data.soulseekMode !== undefined ? data.soulseekMode : oldMode) || "";
        const oldSlskdUrl = existingSettings?.slskdUrl || "";
        const newSlskdUrl = (data.slskdUrl !== undefined ? data.slskdUrl : oldSlskdUrl) || "";
        const oldSlskdApiKey = decryptOrNull("slskdApiKey", existingSettings?.slskdApiKey) ?? "";
        const newSlskdApiKey = (data.slskdApiKey !== undefined ? data.slskdApiKey : oldSlskdApiKey) || "";

        const changed =
          newUsername !== oldUsername ||
          newPassword !== oldPassword ||
          newMode !== oldMode ||
          newSlskdUrl !== oldSlskdUrl ||
          newSlskdApiKey !== oldSlskdApiKey;

        if (changed) {
          const { soulseekService } = await import("../services/soulseek");
          try {
            await soulseekService.resetAndReconnect();
            logger.debug(
              "[SYSTEM SETTINGS] Reset Soulseek connection and reconnected after settings change",
            );
          } catch (err: any) {
            logger.warn(
              `[SYSTEM SETTINGS] Failed to reconnect Soulseek (will retry on first search): ${err.message}`,
            );
          }
        }
      } catch (err) {
        logger.warn("Failed to check/disconnect Soulseek service:", err);
      }
    }

    // Reinitialize services that cache credentials from DB
    try {
      const { lidarrService } = await import("../services/lidarr");
      lidarrService.reinitialize();
    } catch (err) {
      logger.warn("[SYSTEM SETTINGS] Could not reinitialize Lidarr service:", err);
    }

    try {
      const { audiobookshelfService } = await import("../services/audiobookshelf");
      audiobookshelfService.reinitialize();
    } catch (err) {
      logger.warn("[SYSTEM SETTINGS] Could not reinitialize Audiobookshelf service:", err);
    }

    try {
      const { fanartService } = await import("../services/fanart");
      fanartService.reinitialize();
    } catch (err) {
      logger.warn("[SYSTEM SETTINGS] Could not reinitialize Fanart service:", err);
    }

    // If Audiobookshelf was disabled, clear all audiobook-related data
    if (data.audiobookshelfEnabled === false) {
      logger.debug(
        "[CLEANUP] Audiobookshelf disabled - clearing all audiobook data from database",
      );
      try {
        const deletedProgress = await prisma.audiobookProgress.deleteMany({});
        logger.debug(
          `   Deleted ${deletedProgress.count} audiobook progress entries`,
        );
      } catch (clearError) {
        logger.error("Failed to clear audiobook data:", clearError);
        // Don't fail the request
      }
    }

    // Write only non-sensitive config to .env for Docker containers.
    // Secrets (API keys, passwords, tokens) are stored encrypted in the
    // database and must NOT be written in plaintext to the .env file.
    try {
      await writeEnvFile({
        LIDARR_ENABLED: data.lidarrEnabled ? "true" : "false",
        LIDARR_URL: data.lidarrUrl || null,
        AUDIOBOOKSHELF_URL: data.audiobookshelfUrl || null,
        SOULSEEK_USERNAME: data.soulseekUsername || null,
        // The transcode cache cap is read from config (env) at startup, which is
        // why the UI flags a restart. Persist it to .env so the saved slider
        // value actually takes effect on the next boot.
        TRANSCODE_CACHE_MAX_GB:
          data.transcodeCacheMaxGb != null
            ? String(data.transcodeCacheMaxGb)
            : null,
      });
      logger.debug(".env file synchronized with database settings");
    } catch (envError) {
      logger.error("Failed to write .env file:", envError);
      // Don't fail the request if .env write fails
    }

    if (data.lidarrEnabled && data.lidarrUrl && data.lidarrApiKey) {
      try {
        await configureLidarrWebhook(data.lidarrUrl, data.lidarrApiKey);
      } catch (webhookError: any) {
        logger.error("Failed to configure the Lidarr webhook:", webhookError.message);
        if (webhookError.response?.data) {
          logger.error("   Lidarr said:", JSON.stringify(webhookError.response.data));
        }
      }
    }

    res.json({
      success: true,
      message:
        "Settings saved successfully. Restart Docker containers to apply changes.",
      requiresRestart: true,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid settings", details: error.errors });
    }
    logger.error("Update system settings error:", error);
    res.status(500).json({ error: "Failed to update system settings" });
  }
});

// POST /system-settings/test-lidarr
router.post("/test-lidarr", async (req, res) => {
  try {
    const { url, apiKey } = req.body;

    logger.debug("[Lidarr Test] Testing connection to:", url);

    if (!url || !apiKey) {
      return res.status(400).json({ error: "URL and API key are required" });
    }

    const response = await createLidarrClient(url, apiKey, 10_000).get("/api/v1/system/status");

    logger.debug(
      "[Lidarr Test] Connection successful, version:",
      response.data.version,
    );

    res.json({
      success: true,
      message: "Lidarr connection successful",
      version: response.data.version,
    });
  } catch (error) {
    safeError(res, "Lidarr connection test", error);
  }
});

// POST /system-settings/lidarr-profiles
router.post("/lidarr-profiles", async (req, res) => {
  try {
    const { url, apiKey } = req.body;
    if (!url || !apiKey) {
      return res.status(400).json({ error: "URL and API key are required" });
    }

    const lidarr = createLidarrClient(url, apiKey, 10_000);
    const [qualityRes, metadataRes] = await Promise.all([
      lidarr.get("/api/v1/qualityprofile"),
      lidarr.get("/api/v1/metadataprofile"),
    ]);

    res.json({
      qualityProfiles: (qualityRes.data || []).map((p: any) => ({ id: p.id, name: p.name })),
      metadataProfiles: (metadataRes.data || []).map((p: any) => ({ id: p.id, name: p.name })),
    });
  } catch (error) {
    safeError(res, "Lidarr profile fetch", error);
  }
});

// Test Fanart.tv connection
router.post("/test-fanart", async (req, res) => {
  try {
    const { fanartApiKey } = req.body;

    if (!fanartApiKey) {
      return res.status(400).json({ error: "API key is required" });
    }


    // Test with a known artist (The Beatles MBID)
    const testMbid = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

    await axios.get(
      `https://webservice.fanart.tv/v3/music/${testMbid}`,
      {
        params: { api_key: fanartApiKey },
        timeout: 5000,
      },
    );

    // If we get here, the API key is valid
    res.json({
      success: true,
      message: "Fanart.tv connection successful",
    });
  } catch (error) {
    safeError(res, "Fanart.tv connection test", error);
  }
});

// Test Audiobookshelf connection
router.post("/test-audiobookshelf", async (req, res) => {
  try {
    const { url, apiKey } = req.body;

    if (!url || !apiKey) {
      return res.status(400).json({ error: "URL and API key are required" });
    }


    const response = await axios.get(`${url}/api/libraries`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 5000,
    });

    res.json({
      success: true,
      message: "Audiobookshelf connection successful",
      libraries: response.data.libraries?.length || 0,
    });
  } catch (error) {
    safeError(res, "Audiobookshelf connection test", error);
  }
});

// Test Soulseek connection (direct via vendored soulseek-ts)
router.post("/test-soulseek", async (req, res) => {
  try {
    const { username, password, mode, slskdUrl, slskdApiKey } = req.body;

    // Test the backend the user is actually configuring, not the env default.
    const { resolveSlskClient } = await import("../lib/soulseek/client");
    const resolvedMode = mode || (slskdUrl ? "slskd" : "p2p");

    if (resolvedMode === "slskd") {
      // slskd holds its own Soulseek account, so no Kima username/password is
      // needed — just verify the slskd instance is reachable and logged in.
      const { configureSlskd, peekSlskdConfig } = await import(
        "../lib/soulseek/slskd-client"
      );
      const previous = peekSlskdConfig();
      try {
        if (slskdUrl) configureSlskd({ url: slskdUrl, apiKey: slskdApiKey });
        logger.debug(
          `[SOULSEEK-TEST] Testing slskd reachability at "${slskdUrl || previous.url}"...`,
        );
        const ClientImpl = resolveSlskClient("slskd");
        const testClient = new ClientImpl();
        // The slskd adapter ignores credentials; login() probes GET
        // /api/v0/application to confirm reachability + Soulseek login.
        await testClient.login("", "");
        testClient.destroy();
        res.json({
          success: true,
          message: `Connected to slskd${slskdUrl ? ` at ${slskdUrl}` : ""}`,
          isConnected: true,
        });
      } catch (connectError) {
        safeError(res, "slskd connection test", connectError, 502);
      } finally {
        // Restore the live config so a candidate URL never leaks into the
        // running client.
        configureSlskd({ url: previous.url, apiKey: previous.apiKey });
      }
      return;
    }

    // P2P mode: Kima logs in with the user's own Soulseek credentials.
    if (!username || !password) {
      return res.status(400).json({
        error: "Soulseek username and password are required",
      });
    }

    logger.debug(`[SOULSEEK-TEST] Testing connection as "${username}"...`);

    try {
      const ClientImpl = resolveSlskClient("p2p");
      const testClient = new ClientImpl();

      await testClient.login(username, password);
      logger.debug(`[SOULSEEK-TEST] Connected successfully`);
      testClient.destroy();

      res.json({
        success: true,
        message: `Connected to Soulseek as "${username}"`,
        soulseekUsername: username,
        isConnected: true,
      });
    } catch (connectError) {
      safeError(res, "Soulseek connection test", connectError, 502);
    }
  } catch (error) {
    safeError(res, "Soulseek connection test", error);
  }
});

// Test Spotify credentials
router.post("/test-spotify", async (req, res) => {
  try {
    const { clientId, clientSecret } = req.body;

    if (!clientId || !clientSecret) {
      return res.status(400).json({
        error: "Client ID and Client Secret are required",
      });
    }

    // Test credentials by trying to get an access token
    try {
      const response = await axios.post(
        "https://accounts.spotify.com/api/token",
        "grant_type=client_credentials",
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(
              `${clientId}:${clientSecret}`,
            ).toString("base64")}`,
          },
          timeout: 10000,
        },
      );

      if (response.data.access_token) {
        res.json({
          success: true,
          message: "Spotify credentials are valid",
        });
      } else {
        res.status(400).json({
          error: "Invalid Spotify credentials",
        });
      }
    } catch (tokenError) {
      safeError(res, "Spotify credentials test", tokenError, 502);
    }
  } catch (error) {
    safeError(res, "Spotify credentials test", error);
  }
});

// Redis prefixes "Clear Caches" must never delete: queues, sessions, the
// enrichment control plane, locks and SSE tickets. A denylist, so caches added
// later are cleared without being listed.
const PROTECTED_KEY_PREFIXES = [
  "bull:",
  "sess:",
  "audio:",
  "clap:",
  "enrichment",
  "lock:",
  "sse:",
];

// Test an AI provider connection without saving the credentials (#240,
// Manual Mode). The candidate values come from the (unsaved) settings form.
router.post("/test-ai", async (req, res) => {
  try {
    const { provider, apiBaseUrl, model, apiKey } = req.body as {
      provider?: string;
      apiBaseUrl?: string;
      model?: string;
      apiKey?: string;
    };

    if (provider === "openai") {
      if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({ error: "An API key is required for the OpenAI provider" });
      }
    } else if (provider === "openai_compatible") {
      if (!apiBaseUrl?.trim() || !/^https?:\/\//i.test(apiBaseUrl) || !model?.trim()) {
        return res.status(400).json({
          error: "An http(s) endpoint URL and a model name are required for an OpenAI-compatible provider",
        });
      }
    } else {
      return res.status(400).json({
        error: "provider must be 'openai' or 'openai_compatible'",
      });
    }

    const { createAIProvider } = await import("../services/ai/providers");
    const testProvider = createAIProvider({
      provider: provider as "openai" | "openai_compatible",
      apiBaseUrl,
      model,
      apiKey,
    });
    if (!testProvider) {
      return res.status(400).json({ error: "The provider configuration is incomplete" });
    }

    logger.debug(`[AI-TEST] Testing provider "${provider}"...`);
    await testProvider.testConnection();
    res.json({ success: true, message: `Connected to ${provider}` });
  } catch (error) {
    if (error instanceof UserFacingError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    safeError(res, "AI provider connection test", error, 502);
  }
});

// Clear all rebuildable caches (never queue, session, or control-plane state)
router.post("/clear-caches", async (_req, res) => {
  try {
    // SCAN with the ioredis signature: positional MATCH/COUNT args, and an
    // [nextCursor, keys] array result; the cursor is a string, "0" terminates.
    const keysToDelete: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await redisClient.scan(
        cursor,
        "MATCH",
        "*",
        "COUNT",
        500,
      );
      cursor = next;
      for (const key of keys) {
        if (!PROTECTED_KEY_PREFIXES.some((p) => key.startsWith(p))) {
          keysToDelete.push(key);
        }
      }
    } while (cursor !== "0");

    if (keysToDelete.length > 0) {
      // Delete in chunks so a large cache doesn't build one oversized command.
      for (let i = 0; i < keysToDelete.length; i += 500) {
        await redisClient.del(...keysToDelete.slice(i, i + 500));
      }
      logger.debug(
        `[CACHE] Cleared ${keysToDelete.length} cache entries`,
      );

      res.json({
        success: true,
        message: `Cleared ${keysToDelete.length} cache entries`,
        clearedKeys: keysToDelete.length,
      });
    } else {
      res.json({
        success: true,
        message: "No cache entries to clear",
        clearedKeys: 0,
      });
    }
  } catch (error) {
    safeError(res, "Clear caches", error);
  }
});

const gpuToggleSchema = z
  .object({ enabled: z.boolean().optional(), analysis: z.boolean().optional() })
  .refine((body) => body.enabled !== undefined || body.analysis !== undefined);

// GET /system-settings/gpu — the GPU runtime's measured install state
router.get("/gpu", async (_req, res) => {
  try {
    res.json(await getGpuStatus());
  } catch (error) {
    safeError(res, "Get GPU status", error);
  }
});

// POST /system-settings/gpu: the two switches, `enabled` (sound vectors) and `analysis` (audio analysis),
// set through setGpuToggles like the release window's GPU choice.
router.post("/gpu", async (req, res) => {
  try {
    const { enabled, analysis } = gpuToggleSchema.parse(req.body);
    if ((enabled || analysis) && !gpuSupported()) {
      return res.status(400).json({ error: "GPU acceleration is only available on linux/x86_64 hosts" });
    }
    res.json(await setGpuToggles({ soundVectors: enabled, analysis }));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "enabled or analysis (boolean) is required" });
    }
    safeError(res, "Set GPU toggle", error);
  }
});

export default router;
