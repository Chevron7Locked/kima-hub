/**
 * Point Kima at a Lidarr for a test the way the settings page does: the URL
 * and an encrypted key on the settings row, then the service reloads them.
 */
import { prisma } from "../../utils/db";
import { encryptField } from "../../utils/encryption";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { lidarrService } from "../../services/lidarr";

export async function useLidarr(url: string, extra: Record<string, unknown> = {}): Promise<void> {
    const data = {
        lidarrEnabled: true,
        lidarrUrl: url,
        lidarrApiKey: encryptField("recorded-scenario"),
        lidarrQualityProfileId: 3,
        lidarrMetadataProfileId: 1,
        lidarrRemoveJunk: true,
        ...extra,
    };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    invalidateSystemSettingsCache();
    lidarrService.reinitialize();
}

/**
 * Leave Kima with no Lidarr, whatever an earlier test file on this worker left on the settings row (a worker's
 * database is shared by the files it runs in turn). A test that sets up no Lidarr but runs code that asks whether
 * one is configured must say so, or it passes and fails with the order the files happened to run in.
 */
export async function useNoLidarr(): Promise<void> {
    const data = { lidarrEnabled: false, lidarrUrl: null, lidarrApiKey: null };
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    invalidateSystemSettingsCache();
    lidarrService.reinitialize();
}
