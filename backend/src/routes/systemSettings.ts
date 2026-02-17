import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { writeEnvFile } from "../utils/envWriter";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";
import { queueCleaner } from "../jobs/queueCleaner";
import { encrypt, decrypt } from "../utils/encryption";

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

// Only admins can access system settings
router.use(requireAuth);
router.use(requireAdmin);

const systemSettingsSchema = z.object({
  // Download Services
  lidarrEnabled: z.boolean().optional(),
  lidarrUrl: z.string().optional(),
  lidarrApiKey: z.string().nullable().optional(),
  lidarrWebhookSecret: z.string().nullable().optional(),

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
      spotifyClientSecret: safeDecrypt(settings.spotifyClientSecret),
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
    if (data.spotifyClientSecret)
      encryptedData.spotifyClientSecret = encrypt(data.spotifyClientSecret);

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

    // Disconnect Soulseek only if credentials actually changed (not just present in payload)
    if (
      data.soulseekUsername !== undefined ||
      data.soulseekPassword !== undefined
    ) {
      try {
        const oldUsername = existingSettings?.soulseekUsername || "";
        const oldPassword = existingSettings?.soulseekPassword ? safeDecrypt(existingSettings.soulseekPassword) : "";
        const newUsername = data.soulseekUsername !== undefined ? data.soulseekUsername : oldUsername;
        const newPassword = data.soulseekPassword !== undefined ? data.soulseekPassword : oldPassword;

        if (newUsername !== oldUsername || newPassword !== oldPassword) {
          const { soulseekService } = await import("../services/soulseek");
          try {
            await soulseekService.resetAndReconnect();
            logger.debug(
              "[SYSTEM SETTINGS] Reset Soulseek connection and reconnected with new credentials",
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

        // Find existing Kima webhook by name (primary) or URL pattern (fallback)
        const existingWebhook = notificationsResponse.data.find(
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
  } catch (error: any) {
    logger.error("[Lidarr Test] Error:", error.message);
    logger.error("[Lidarr Test] Details:", error.response?.data || error.code);

    let details = error.message;
    if (error.code === "ECONNREFUSED") {
      details =
        "Connection refused - check if Lidarr is running and accessible";
    } else if (error.code === "ENOTFOUND") {
      details = "Host not found - check the URL";
    } else if (error.response?.status === 401) {
      details = "Invalid API key";
    } else if (error.response?.data?.message) {
      details = error.response.data.message;
    }

    res.status(500).json({
      error: "Failed to connect to Lidarr",
      details,
    });
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
  } catch (error: any) {
    logger.error("OpenAI test error:", error.message);
    res.status(500).json({
      error: "Failed to connect to OpenAI",
      details: error.response?.data?.error?.message || error.message,
    });
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
  } catch (error: any) {
    logger.error("Fanart.tv test error:", error.message);
    if (error.response?.status === 401) {
      res.status(401).json({
        error: "Invalid Fanart.tv API key",
      });
    } else {
      res.status(500).json({
        error: "Failed to connect to Fanart.tv",
        details: error.response?.data || error.message,
      });
    }
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
  } catch (error: any) {
    logger.error("Last.fm test error:", error.message);
    if (error.response?.status === 403 || error.response?.data?.error === 10) {
      res.status(401).json({
        error: "Invalid Last.fm API key",
      });
    } else {
      res.status(500).json({
        error: "Failed to connect to Last.fm",
        details: error.response?.data || error.message,
      });
    }
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
  } catch (error: any) {
    logger.error("Audiobookshelf test error:", error.message);
    if (error.response?.status === 401 || error.response?.status === 403) {
      res.status(401).json({
        error: "Invalid Audiobookshelf API key",
      });
    } else {
      res.status(500).json({
        error: "Failed to connect to Audiobookshelf",
        details: error.response?.data || error.message,
      });
    }
  }
});

// Test Soulseek connection (direct via vendored soulseek-ts)
router.post("/test-soulseek", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "Soulseek username and password are required",
      });
    }

    logger.debug(`[SOULSEEK-TEST] Testing connection as "${username}"...`);

    try {
      const { SlskClient } = await import("../lib/soulseek/client");
      const testClient = new SlskClient();

      await testClient.login(username, password);
      logger.debug(`[SOULSEEK-TEST] Connected successfully`);
      testClient.destroy();

      res.json({
        success: true,
        message: `Connected to Soulseek as "${username}"`,
        soulseekUsername: username,
        isConnected: true,
      });
    } catch (connectError: any) {
      logger.error(`[SOULSEEK-TEST] Error: ${connectError.message}`);
      res.status(401).json({
        error: "Invalid Soulseek credentials or connection failed",
        details: connectError.message,
      });
    }
  } catch (error: any) {
    logger.error("[SOULSEEK-TEST] Error:", error.message);
    res.status(500).json({
      error: "Failed to test Soulseek connection",
      details: error.message,
    });
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
    } catch (tokenError: any) {
      res.status(401).json({
        error: "Invalid Spotify credentials",
        details:
          tokenError.response?.data?.error_description || tokenError.message,
      });
    }
  } catch (error: any) {
    logger.error("Spotify test error:", error.message);
    res.status(500).json({
      error: "Failed to test Spotify credentials",
      details: error.message,
    });
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
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to start queue cleaner",
      details: error.message,
    });
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

// Clear all Redis caches
router.post("/clear-caches", async (req, res) => {
  try {
    const { redisClient } = require("../utils/redis");
    const { notificationService } =
      await import("../services/notificationService");

    // Collect all keys using SCAN (non-blocking) and exclude session keys
    const allKeys: string[] = [];
    let cursor = 0;
    do {
      const result = await redisClient.scan(cursor, { MATCH: "*", COUNT: 100 });
      cursor = result.cursor;
      allKeys.push(...result.keys);
    } while (cursor !== 0);

    const keysToDelete = allKeys.filter(
      (key: string) => !key.startsWith("sess:"),
    );

    if (keysToDelete.length > 0) {
      logger.debug(
        `[CACHE] Clearing ${keysToDelete.length} cache entries (excluding ${
          allKeys.length - keysToDelete.length
        } session keys)...`,
      );
      await redisClient.del(keysToDelete);
      logger.debug(
        `[CACHE] Successfully cleared ${keysToDelete.length} cache entries`,
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
  } catch (error: any) {
    logger.error("Clear caches error:", error);
    res.status(500).json({
      error: "Failed to clear caches",
      details: error.message,
    });
  }
});

export default router;
