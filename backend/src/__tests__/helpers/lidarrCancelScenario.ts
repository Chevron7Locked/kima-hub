/**
 * Every test gets a fresh replay of the "stalled-then-cancelled" recording
 * with Kima pointed at it; `unmonitored()` lists the album ids each "stop
 * monitoring this album" request carried.
 */
import { loadScenario, startLidarrReplay, type LidarrReplay } from "./lidarrReplay";
import { useLidarr, useNoLidarr } from "./lidarrSettings";

export function useLidarrCancelScenario(): { unmonitored: () => any[] } {
    let lidarr!: LidarrReplay;

    beforeEach(async () => {
        lidarr = await startLidarrReplay(loadScenario("stalled-then-cancelled"));
        await useLidarr(lidarr.url);
    });

    afterEach(() => lidarr.close());

    // The settings row outlives the file on this worker: leave no Lidarr on it.
    afterAll(useNoLidarr);

    return {
        unmonitored: () =>
            lidarr.asked.filter((a) => a.method === "PUT" && a.path === "/api/v1/album/monitor").map((a) => (a.body as any).albumIds),
    };
}
