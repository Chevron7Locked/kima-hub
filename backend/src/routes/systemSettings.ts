import { Router } from "express";
import path from "path";
import fs from "fs";
import axios from "axios";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { mayAcquire } from "../utils/acquirePermission";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { z } from "zod";
import { invalidateSystemSettingsCache, QUEUE_LENGTH } from "../utils/systemSettings";
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
import { config, musicFolderProblem, musicPathFixedByEnv, useMusicFolder } from "../config";
import { createLidarrClient } from "../services/lidarrClient";
import { safeError } from "../utils/errors";

const router = Router();

// Any signed-in user: the server's public address, and whether this user may start downloads.
router.get("/public-config", requireAuth, async (req, res) => {
  try {
    const settings = await prisma.systemSettings.findUnique({
      where: { id: "default" },
      select: { publicUrl: true },
    });
    // Members need this to know whether to offer download buttons; the
    // server enforces the same rule regardless of what the UI shows.
    res.json({ publicUrl: settings?.publicUrl || "", canAcquire: await mayAcquire(req.user!) });
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
  allowMemberAcquire: z.boolean().optional(),
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

  // Storage Paths
  musicPath: z.string().optional(),

  // Feature Flags
  autoSync: z.boolean().optional(),

  // Advanced Settings
  transcodeCacheMaxGb: z.number().optional(),
  maxQueueLength: z.number().int().min(QUEUE_LENGTH.min).max(QUEUE_LENGTH.max).optional(),
  soulseekConcurrentDownloads: z.number().min(1).max(10).optional(),

  // Download Preferences
  downloadSource: z.enum(["soulseek", "lidarr"]).optional(),
  primaryFailureFallback: z.enum(["none", "lidarr", "soulseek"]).optional(),

  // Server
  publicUrl: z.union([z.string().url(), z.literal("")]).optional(),
  registrationOpen: z.boolean().optional(),
  updateChecksEnabled: z.boolean().optional(),
  podcastChartCountry: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/).optional(),
});

/** Whether the library's songs are in `folder`: yes with no songs yet, or when most of a sample's files are there. */
async function libraryFoundIn(folder: string): Promise<boolean> {
  const sample = await prisma.track.findMany({
    where: { missingSince: null },
    select: { filePath: true },
    orderBy: { id: "asc" },
    take: 50,
  });
  const found = sample.filter((t) => fs.existsSync(path.join(folder, t.filePath))).length;
  return found * 2 > sample.length || sample.length === 0;
}

// GET /system-settings
router.get("/", async (_req, res) => {
  try {
    let settings = await prisma.systemSettings.findUnique({
      where: { id: "default" },
    });

    // A new server's row takes the schema's defaults.
    if (!settings) {
      settings = await prisma.systemSettings.create({ data: { id: "default" } });
    }

    // Decrypt every field in ENCRYPTED_FIELDS before sending to the client.
    const resolved = await resolveEncryptedSettings({ ...settings });

    // The folder actually in use, which MUSIC_PATH can fix whatever the row says.
    res.json({ ...resolved, musicPath: config.music.musicPath, musicPathFixedByEnv: musicPathFixedByEnv() });
  } catch (error) {
    logger.error("Get system settings error:", error);
    res.status(500).json({ error: "Failed to get system settings" });
  }
});

// POST /system-settings
router.post("/", async (req, res) => {
  try {
    const data = systemSettingsSchema.parse(req.body);

    // One music folder for scans and downloads alike; a new one is checked, then used at once.
    // Only a changed folder is checked: every save sends it back, and one in use that is briefly missing (a disk not
    // mounted yet) must not block saving anything else.
    if (data.musicPath !== undefined) {
      const folder = path.resolve(data.musicPath.trim());
      if (folder === path.resolve(config.music.musicPath)) {
        delete data.musicPath;
      } else if (musicPathFixedByEnv()) {
        return res.status(400).json({
          error: `The music folder is set by the server's MUSIC_PATH (${config.music.musicPath}) and cannot be changed here`,
        });
      } else {
        const problem = musicFolderProblem(folder);
        if (problem) return res.status(400).json({ error: problem });
        // Scans drop songs they keep not finding, so a folder without the library would empty it.
        if (!(await libraryFoundIn(folder))) {
          return res.status(400).json({
            error: `None of the library's songs are in ${folder}; move the music there first`,
          });
        }
        data.musicPath = folder;
      }
    }

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
    if (data.musicPath !== undefined) useMusicFolder(data.musicPath);

    // Reconnect Soulseek only when a connection setting actually changed: the P2P
    // credentials or the slskd backend (mode, URL, API key, download folder).
    if (
      data.soulseekUsername !== undefined ||
      data.soulseekPassword !== undefined ||
      data.soulseekMode !== undefined ||
      data.slskdUrl !== undefined ||
      data.slskdApiKey !== undefined ||
      data.soulseekDownloadPath !== undefined
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
        const oldDownloads = existingSettings?.soulseekDownloadPath || "";
        const newDownloads = (data.soulseekDownloadPath !== undefined ? data.soulseekDownloadPath : oldDownloads) || "";
        const newSlskdApiKey = (data.slskdApiKey !== undefined ? data.slskdApiKey : oldSlskdApiKey) || "";

        const changed =
          newUsername !== oldUsername ||
          newPassword !== oldPassword ||
          newMode !== oldMode ||
          newSlskdUrl !== oldSlskdUrl ||
          newSlskdApiKey !== oldSlskdApiKey ||
          newDownloads !== oldDownloads;

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

    // Audiobookshelf turned off: its listening progress goes with it. A failure here does not fail the save.
    if (data.audiobookshelfEnabled === false) {
      try {
        const deletedProgress = await prisma.audiobookProgress.deleteMany({});
        logger.debug(`[SYSTEM SETTINGS] Audiobookshelf off: deleted ${deletedProgress.count} progress entries`);
      } catch (clearError) {
        logger.error("Failed to clear audiobook progress:", clearError);
      }
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

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Invalid settings", details: error.issues });
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
