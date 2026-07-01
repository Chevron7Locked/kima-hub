import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { writeEnvFile } from "../utils/envWriter";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";
import { queueCleaner } from "../jobs/queueCleaner";
import { encrypt, decrypt } from "../utils/encryption";
import { safeError } from "../utils/errors";

const router = Router();

/**
 * Safely decrypt a field, returning null if decryption fails
 */
function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch (error) {
    logger.warn("[Settings Route] Failed to decrypt field, returning null");
    return null;
  }
}

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

  // OIDC / SSO
  oidcEnabled: z.boolean().optional(),
  oidcProviderName: z.string().nullable().optional(),
  oidcIssuer: z
    .union([z.string().url(), z.literal("")])
    .nullable()
    .optional(),
  oidcClientId: z.string().nullable().optional(),
  oidcClientSecret: z.string().nullable().optional(),
  oidcScopes: z.string().nullable().optional(),
  oidcRoleClaim: z.string().nullable().optional(),
  oidcAdminValue: z.string().nullable().optional(),
  oidcAutoLinkByUsername: z.boolean().optional(),

  // AI Services
  openaiEnabled: z.boolean().optional(),
  openaiApiKey: z.string().nullable().optional(),
  openaiModel: z.string().optional(),
  openaiBaseUrl: z.string().nullable().optional(),

  fanartEnabled: z.boolean().optional(),
  fanartApiKey: z.string().nullable().optional(),

  // Last.fm
  lastfmApiKey: z.string().nullable().optional(),
  lastfmApiSecret: z.string().nullable().optional(),
  lastfmUserKey: z.string().nullable().optional(),
  lastfmEnabled: z.boolean().nullable().optional(),

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
  maxConcurrentDownloads: z.number().optional(),
  downloadRetryAttempts: z.number().optional(),
  transcodeCacheMaxGb: z.number().optional(),
  soulseekConcurrentDownloads: z.number().min(1).max(10).optional(),

  // Download Preferences
  downloadSource: z.enum(["soulseek", "lidarr"]).optional(),
  primaryFailureFallback: z.enum(["none", "lidarr", "soulseek"]).optional(),

  // Server
  publicUrl: z.union([z.string().url(), z.literal("")]).optional(),
  registrationOpen: z.boolean().optional(),
});

// GET /system-settings
router.get("/", async (req, res) => {
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
          openaiEnabled: false,
          openaiModel: "gpt-4",
          fanartEnabled: false,
          audiobookshelfEnabled: false,
          audiobookshelfUrl: "http://localhost:13378",
          musicPath: "/music",
          downloadPath: "/downloads",
          autoSync: true,
          autoEnrichMetadata: true,
          maxConcurrentDownloads: 3,
          downloadRetryAttempts: 3,
          transcodeCacheMaxGb: 10,
          soulseekConcurrentDownloads: 4,
        },
      });
    }

    // Decrypt sensitive fields before sending to client
    // Use safeDecrypt to handle corrupted encrypted values gracefully
    const decryptedSettings = {
      ...settings,
      lidarrApiKey: safeDecrypt(settings.lidarrApiKey),
      lidarrWebhookSecret: safeDecrypt(settings.lidarrWebhookSecret),
      openaiApiKey: safeDecrypt(settings.openaiApiKey),
      fanartApiKey: safeDecrypt(settings.fanartApiKey),
      lastfmApiKey: safeDecrypt(settings.lastfmApiKey),
      lastfmApiSecret: safeDecrypt(settings.lastfmApiSecret),
      lastfmUserKey: safeDecrypt(settings.lastfmUserKey),
      audiobookshelfApiKey: safeDecrypt(settings.audiobookshelfApiKey),
      soulseekPassword: safeDecrypt(settings.soulseekPassword),
      slskdApiKey: safeDecrypt(settings.slskdApiKey),
      spotifyClientSecret: safeDecrypt(settings.spotifyClientSecret),
      oidcClientSecret: safeDecrypt(settings.oidcClientSecret),
    };

    res.json(decryptedSettings);
  } catch (error) {
    logger.error("Get system settings error:", error);
    res.status(500).json({ error: "Failed to get system settings" });
  }
});

// POST /system-settings
router.post("/", async (req, res) => {
  try {
    const data = systemSettingsSchema.parse(req.body);

    logger.debug("[SYSTEM SETTINGS] Saving settings...");
    logger.debug(
      "[SYSTEM SETTINGS] transcodeCacheMaxGb:",
      data.transcodeCacheMaxGb,
    );

    // Encrypt sensitive fields
    const encryptedData: any = { ...data };

    if (data.lidarrApiKey)
      encryptedData.lidarrApiKey = encrypt(data.lidarrApiKey);
    if (data.lidarrWebhookSecret)
      encryptedData.lidarrWebhookSecret = encrypt(data.lidarrWebhookSecret);
    if (data.openaiApiKey)
      encryptedData.openaiApiKey = encrypt(data.openaiApiKey);
    if (data.fanartApiKey)
      encryptedData.fanartApiKey = encrypt(data.fanartApiKey);
    if (data.lastfmApiKey)
      encryptedData.lastfmApiKey = encrypt(data.lastfmApiKey);
    if (data.lastfmApiSecret)
      encryptedData.lastfmApiSecret = encrypt(data.lastfmApiSecret);
    if (data.lastfmUserKey)
      encryptedData.lastfmUserKey = encrypt(data.lastfmUserKey);
    if (data.audiobookshelfApiKey)
      encryptedData.audiobookshelfApiKey = encrypt(data.audiobookshelfApiKey);
    if (data.soulseekPassword)
      encryptedData.soulseekPassword = encrypt(data.soulseekPassword);
    if (data.slskdApiKey)
      encryptedData.slskdApiKey = encrypt(data.slskdApiKey);
    if (data.spotifyClientSecret)
      encryptedData.spotifyClientSecret = encrypt(data.spotifyClientSecret);
    if (data.oidcClientSecret)
      encryptedData.oidcClientSecret = encrypt(data.oidcClientSecret);

    // Fetch existing settings before save to detect credential changes
    const existingSettings = await prisma.systemSettings.findUnique({ where: { id: "default" } });

    const settings = await prisma.systemSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        ...encryptedData,
      },
      update: encryptedData,
    });

    invalidateSystemSettingsCache();

    // Refresh Last.fm API key if it was updated
    try {
      const { lastFmService } = await import("../services/lastfm");
      await lastFmService.refreshApiKey();
    } catch (err) {
      logger.warn("Failed to refresh Last.fm API key:", err);
    }

    // Reconnect Soulseek only if connection-relevant settings actually changed
    // (not just present in payload). This covers P2P credentials AND the slskd
    // backend selection — switching soulseekMode or editing slskdUrl/slskdApiKey
    // now reconnects the chosen backend immediately (connect() re-reads settings
    // and re-runs configureSlskd/resolveSlskClient), instead of the toggle
    // appearing to do nothing until an unrelated reconnect.
    if (
      data.soulseekUsername !== undefined ||
      data.soulseekPassword !== undefined ||
      data.soulseekMode !== undefined ||
      data.slskdUrl !== undefined ||
      data.slskdApiKey !== undefined
    ) {
      try {
        const oldUsername = existingSettings?.soulseekUsername || "";
        const oldPassword = existingSettings?.soulseekPassword ? safeDecrypt(existingSettings.soulseekPassword) : "";
        const newUsername = data.soulseekUsername !== undefined ? data.soulseekUsername : oldUsername;
        const newPassword = data.soulseekPassword !== undefined ? data.soulseekPassword : oldPassword;

        const oldMode = existingSettings?.soulseekMode || "";
        const newMode = (data.soulseekMode !== undefined ? data.soulseekMode : oldMode) || "";
        const oldSlskdUrl = existingSettings?.slskdUrl || "";
        const newSlskdUrl = (data.slskdUrl !== undefined ? data.slskdUrl : oldSlskdUrl) || "";
        const oldSlskdApiKey = existingSettings?.slskdApiKey ? safeDecrypt(existingSettings.slskdApiKey) : "";
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

    // Drop the cached OIDC discovery client so issuer/client changes apply now.
    if (
      data.oidcIssuer !== undefined ||
      data.oidcClientId !== undefined ||
      data.oidcClientSecret !== undefined ||
      data.oidcScopes !== undefined ||
      data.oidcEnabled !== undefined
    ) {
      try {
        const { oidcService } = await import("../services/oidc");
        oidcService.reset();
      } catch (err) {
        logger.warn("[SYSTEM SETTINGS] Could not reset OIDC service:", err);
      }
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

    // Auto-configure Lidarr webhook if Lidarr is enabled
    if (data.lidarrEnabled && data.lidarrUrl && data.lidarrApiKey) {
      try {
        logger.debug("[LIDARR] Auto-configuring webhook...");

        const axios = (await import("axios")).default;
        const lidarrUrl = data.lidarrUrl;
        const apiKey = data.lidarrApiKey;

        // Determine webhook URL
        // Use KIMA_CALLBACK_URL env var if set, otherwise default to backend:3006
        // In Docker, services communicate via Docker network names (backend, lidarr, etc.)
        const callbackHost =
          process.env.KIMA_CALLBACK_URL || "http://backend:3006";
        const webhookUrl = `${callbackHost}/api/webhooks/lidarr`;

        logger.debug(`   Webhook URL: ${webhookUrl}`);

        // Check if webhook already exists - find by name "Kima" OR by URL containing "lidify" or "webhooks/lidarr"
        const notificationsResponse = await axios.get(
          `${lidarrUrl}/api/v1/notification`,
          {
            headers: { "X-Api-Key": apiKey },
            timeout: 10000,
          },
        );

        // The Lidarr /api/v1/notification endpoint always returns a flat array,
        // but some versions or proxies may return a paged envelope ({ records: [...] })
        // or an error object. Normalise before use.
        const notificationsRaw = notificationsResponse.data;
        if (!Array.isArray(notificationsRaw) && !Array.isArray(notificationsRaw?.records)) {
          throw new Error(
            `Unexpected response shape from /api/v1/notification: ${typeof notificationsRaw} — aborting webhook setup to prevent duplicate creation`,
          );
        }
        const notifications: any[] = Array.isArray(notificationsRaw)
          ? notificationsRaw
          : notificationsRaw.records;

        // Find existing Kima webhook by name (primary) or URL pattern (fallback)
        const existingWebhook = notifications.find(
          (n: any) =>
            n.implementation === "Webhook" &&
            // Match by name
            (n.name === "Kima" ||
              // Or match by URL pattern (catches old webhooks with different URLs)
              n.fields?.find(
                (f: any) =>
                  f.name === "url" &&
                  (f.value?.includes("webhooks/lidarr") ||
                    f.value?.includes("lidify")),
              )),
        );

        if (existingWebhook) {
          const currentUrl = existingWebhook.fields?.find(
            (f: any) => f.name === "url",
          )?.value;
          logger.debug(
            `   Found existing webhook: "${existingWebhook.name}" with URL: ${currentUrl}`,
          );
          if (currentUrl !== webhookUrl) {
            logger.debug(`   URL needs updating from: ${currentUrl}`);
            logger.debug(`   URL will be updated to: ${webhookUrl}`);
          }
        }

        const webhookConfig = {
          onGrab: true,
          onReleaseImport: true,
          onAlbumDownload: true,
          onDownloadFailure: true,
          onImportFailure: true,
          onAlbumDelete: true,
          onRename: true,
          onHealthIssue: false,
          onApplicationUpdate: false,
          supportsOnGrab: true,
          supportsOnReleaseImport: true,
          supportsOnAlbumDownload: true,
          supportsOnDownloadFailure: true,
          supportsOnImportFailure: true,
          supportsOnAlbumDelete: true,
          supportsOnRename: true,
          supportsOnHealthIssue: true,
          supportsOnApplicationUpdate: true,
          includeHealthWarnings: false,
          name: "Kima",
          implementation: "Webhook",
          implementationName: "Webhook",
          configContract: "WebhookSettings",
          infoLink: "https://wiki.servarr.com/lidarr/supported#webhook",
          tags: [],
          fields: [
            { name: "url", value: webhookUrl },
            { name: "method", value: 1 }, // 1 = POST
            { name: "username", value: "" },
            { name: "password", value: "" },
          ],
        };

        if (existingWebhook) {
          if (!existingWebhook.id) {
            throw new Error(
              `Found existing webhook "${existingWebhook.name}" but it has no id — aborting webhook setup`,
            );
          }
          // Update existing webhook
          await axios.put(
            `${lidarrUrl}/api/v1/notification/${existingWebhook.id}?forceSave=true`,
            { ...existingWebhook, ...webhookConfig },
            {
              headers: { "X-Api-Key": apiKey },
              timeout: 10000,
            },
          );
          logger.debug("   Webhook updated");
        } else {
          // Create new webhook (use forceSave to skip test)
          await axios.post(
            `${lidarrUrl}/api/v1/notification?forceSave=true`,
            webhookConfig,
            {
              headers: { "X-Api-Key": apiKey },
              timeout: 10000,
            },
          );
          logger.debug("   Webhook created");
        }

        logger.debug("Lidarr webhook configured automatically\n");
      } catch (webhookError: any) {
        logger.error("Failed to auto-configure webhook:", webhookError.message);
        if (webhookError.response?.data) {
          logger.error(
            "   Lidarr error details:",
            JSON.stringify(webhookError.response.data, null, 2),
          );
        }
        logger.debug(" User can configure webhook manually in Lidarr UI\n");
        // Don't fail the request if webhook config fails
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

    // Normalize URL - remove trailing slash
    const normalizedUrl = url.replace(/\/+$/, "");

    const axios = require("axios");
    const response = await axios.get(`${normalizedUrl}/api/v1/system/status`, {
      headers: { "X-Api-Key": apiKey },
      timeout: 10000,
    });

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

    const normalizedUrl = url.replace(/\/+$/, "");

    const axios = require("axios");
    const headers = { "X-Api-Key": apiKey };
    const timeout = 10000;

    const [qualityRes, metadataRes] = await Promise.all([
      axios.get(`${normalizedUrl}/api/v1/qualityprofile`, { headers, timeout }),
      axios.get(`${normalizedUrl}/api/v1/metadataprofile`, { headers, timeout }),
    ]);

    res.json({
      qualityProfiles: (qualityRes.data || []).map((p: any) => ({ id: p.id, name: p.name })),
      metadataProfiles: (metadataRes.data || []).map((p: any) => ({ id: p.id, name: p.name })),
    });
  } catch (error) {
    safeError(res, "Lidarr profile fetch", error);
  }
});

// POST /system-settings/test-openai
router.post("/test-openai", async (req, res) => {
  try {
    const { apiKey, model } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: "API key is required" });
    }

    const axios = require("axios");
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: model || "gpt-3.5-turbo",
        messages: [{ role: "user", content: "Test" }],
        max_tokens: 5,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 10000,
      },
    );

    res.json({
      success: true,
      message: "OpenAI connection successful",
      model: response.data.model,
    });
  } catch (error) {
    safeError(res, "OpenAI connection test", error);
  }
});

// Test Fanart.tv connection
router.post("/test-fanart", async (req, res) => {
  try {
    const { fanartApiKey } = req.body;

    if (!fanartApiKey) {
      return res.status(400).json({ error: "API key is required" });
    }

    const axios = require("axios");

    // Test with a known artist (The Beatles MBID)
    const testMbid = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

    const response = await axios.get(
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

// Test Last.fm connection
router.post("/test-lastfm", async (req, res) => {
  try {
    const { lastfmApiKey } = req.body;

    if (!lastfmApiKey) {
      return res.status(400).json({ error: "API key is required" });
    }

    const axios = require("axios");

    // Test with a known artist (The Beatles)
    const testArtist = "The Beatles";

    const response = await axios.get("http://ws.audioscrobbler.com/2.0/", {
      params: {
        method: "artist.getinfo",
        artist: testArtist,
        api_key: lastfmApiKey,
        format: "json",
      },
      timeout: 5000,
    });

    // If we get here and have artist data, the API key is valid
    if (response.data.artist) {
      res.json({
        success: true,
        message: "Last.fm connection successful",
      });
    } else {
      res.status(500).json({
        error: "Unexpected response from Last.fm",
      });
    }
  } catch (error) {
    safeError(res, "Last.fm connection test", error);
  }
});

// Test OIDC issuer (runs discovery against the issuer URL)
router.post("/test-oidc", async (req, res) => {
  try {
    const { issuer } = req.body;
    if (!issuer || typeof issuer !== "string") {
      return res.status(400).json({ error: "Issuer URL is required" });
    }
    const { oidcService } = await import("../services/oidc");
    const info = await oidcService.testIssuer(issuer.trim());
    res.json({
      success: true,
      message: `Discovered ${info.issuer}`,
      ...info,
    });
  } catch (error) {
    safeError(res, "OIDC discovery test", error);
  }
});
// Test Audiobookshelf connection
router.post("/test-audiobookshelf", async (req, res) => {
  try {
    const { url, apiKey } = req.body;

    if (!url || !apiKey) {
      return res.status(400).json({ error: "URL and API key are required" });
    }

    const axios = require("axios");

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
        safeError(res, "slskd connection test", connectError, 401);
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
      safeError(res, "Soulseek connection test", connectError, 401);
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
    const axios = require("axios");
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
        res.status(401).json({
          error: "Invalid Spotify credentials",
        });
      }
    } catch (tokenError) {
      safeError(res, "Spotify credentials test", tokenError, 401);
    }
  } catch (error) {
    safeError(res, "Spotify credentials test", error);
  }
});

// Get queue cleaner status
router.get("/queue-cleaner-status", (req, res) => {
  res.json(queueCleaner.getStatus());
});

// Start queue cleaner manually
router.post("/queue-cleaner/start", async (req, res) => {
  try {
    await queueCleaner.start();
    res.json({
      success: true,
      message: "Queue cleaner started",
      status: queueCleaner.getStatus(),
    });
  } catch (error) {
    safeError(res, "Start queue cleaner", error);
  }
});

// Stop queue cleaner manually
router.post("/queue-cleaner/stop", (req, res) => {
  queueCleaner.stop();
  res.json({
    success: true,
    message: "Queue cleaner stopped",
    status: queueCleaner.getStatus(),
  });
});

// Operational Redis namespaces that "Clear Caches" must NEVER delete: BullMQ
// queues, sessions, the enrichment/analysis control plane, distributed locks,
// and short-lived SSE auth tickets. Everything else is a rebuildable cache
// (external-API responses, cover art, derived data). This is a DENYLIST, not an
// allowlist, on purpose -- the codebase has 20+ cache prefixes and adds more
// over time, so an allowlist would silently leave new caches uncleared. Sparing
// only this small, well-defined operational set keeps the clear complete while
// never touching live state. (The prior version both used the wrong scan API
// for our ioredis client -- so it threw every call -- and, had it run, would
// have wiped queue state.)
const PROTECTED_KEY_PREFIXES = [
  "bull:",
  "sess:",
  "audio:",
  "clap:",
  "enrichment",
  "lock:",
  "sse:",
];

// Clear all rebuildable caches (never queue, session, or control-plane state)
router.post("/clear-caches", async (req, res) => {
  try {
    const { redisClient } = require("../utils/redis");
    const { notificationService } =
      await import("../services/notificationService");

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

      // Send notification to user
      await notificationService.notifySystem(
        req.user!.id,
        "Caches Cleared",
        `Successfully cleared ${keysToDelete.length} cache entries`,
      );

      res.json({
        success: true,
        message: `Cleared ${keysToDelete.length} cache entries`,
        clearedKeys: keysToDelete.length,
      });
    } else {
      await notificationService.notifySystem(
        req.user!.id,
        "Caches Cleared",
        "No cache entries to clear",
      );

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

export default router;
