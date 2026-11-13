/**
 * `useNoLidarr` leaves Kima with no Lidarr whatever an earlier file on the worker configured: the settings row
 * and the cached settings both say so afterwards.
 */
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { isLidarrConfigured } from "../services/lidarrClient";
import { useLidarr, useNoLidarr } from "./helpers/lidarrSettings";
import { closeEngineConnections } from "./helpers/engineConnections";

afterAll(async () => {
    await useNoLidarr();
    await closeEngineConnections();
});

it("undoes a configured Lidarr, in the row and in the cached settings", async () => {
    await useLidarr("http://lidarr.invalid:8686");
    expect(isLidarrConfigured(await getSystemSettings())).toBe(true);

    await useNoLidarr();

    expect(isLidarrConfigured(await getSystemSettings())).toBe(false);
    const row = await prisma.systemSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect(row).toMatchObject({ lidarrEnabled: false, lidarrUrl: null, lidarrApiKey: null });
});

it("works when no settings row exists yet", async () => {
    await prisma.systemSettings.deleteMany({ where: { id: "default" } });

    await useNoLidarr();

    expect(isLidarrConfigured(await getSystemSettings())).toBe(false);
});
