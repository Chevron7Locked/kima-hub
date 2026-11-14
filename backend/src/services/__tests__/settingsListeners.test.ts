/**
 * The modules that hold settings each add a listener for the fields they read, so the settings save reloads exactly
 * the ones whose fields changed: Lidarr, Audiobookshelf, fanart, feature detection, and Soulseek, which reconnects
 * only for its own connection settings. Real database; each reload is watched, and Soulseek's reconnect is stood in for.
 */
import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache, saveSystemSettings } from "../../utils/systemSettings";
import { lidarrService } from "../lidarr";
import { audiobookshelfService } from "../audiobookshelf";
import { fanartService } from "../fanart";
import { featureDetection } from "../featureDetection";
import { redisClient } from "../../utils/redis";
import { closeClient } from "../../utils/closeRedisClient";
import { queues } from "../../workers/queues";
import { closeQueue } from "../../__tests__/helpers/closeQueue";

let before: Record<string, unknown> | null;
let soulseekService: typeof import("../soulseek").soulseekService;
const reload = {
    lidarr: jest.spyOn(lidarrService, "reinitialize"),
    audiobookshelf: jest.spyOn(audiobookshelfService, "reinitialize"),
    fanart: jest.spyOn(fanartService, "reinitialize"),
};
let reconnect: jest.SpyInstance;

beforeAll(async () => {
    before = await prisma.systemSettings.findUnique({ where: { id: "default" } });
    // Soulseek starts connecting as it loads when it is enabled; it is not.
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", soulseekEnabled: false }, update: { soulseekEnabled: false } });
    invalidateSystemSettingsCache();
    ({ soulseekService } = await import("../soulseek"));
    reconnect = jest.spyOn(soulseekService, "resetAndReconnect").mockResolvedValue(undefined);
});

beforeEach(async () => {
    await prisma.systemSettings.update({
        where: { id: "default" },
        data: {
            lidarrEnabled: false,
            lidarrUrl: "http://lidarr.test:8686",
            lidarrApiKey: null,
            fanartEnabled: false,
            fanartApiKey: null,
            audiobookshelfEnabled: false,
            audiobookshelfApiKey: null,
            soulseekEnabled: false,
            soulseekUsername: "user",
            soulseekPassword: null,
            soulseekMode: "p2p",
            slskdUrl: null,
            slskdApiKey: null,
            soulseekDownloadPath: null,
            transcodeCacheMaxGb: 10,
        },
    });
    invalidateSystemSettingsCache();
    jest.clearAllMocks();
});

afterAll(async () => {
    if (before) await prisma.systemSettings.update({ where: { id: "default" }, data: before as any });
    else await prisma.systemSettings.deleteMany({ where: { id: "default" } });
    invalidateSystemSettingsCache();
    soulseekService.disconnect();
    await Promise.all(queues.map((q) => closeQueue(q)));
    await closeClient(redisClient);
});

it("an unrelated setting reloads nothing", async () => {
    await saveSystemSettings({ transcodeCacheMaxGb: 20 });

    expect(reload.lidarr).not.toHaveBeenCalled();
    expect(reload.audiobookshelf).not.toHaveBeenCalled();
    expect(reload.fanart).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
});

it("a changed Lidarr address or key reloads Lidarr alone", async () => {
    await saveSystemSettings({ lidarrUrl: "http://other.test:8686" });
    await saveSystemSettings({ lidarrApiKey: "new-key" });

    expect(reload.lidarr).toHaveBeenCalledTimes(2);
    expect(reload.audiobookshelf).not.toHaveBeenCalled();
    expect(reload.fanart).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
});

it("a changed Audiobookshelf key reloads Audiobookshelf alone", async () => {
    await saveSystemSettings({ audiobookshelfApiKey: "abs-key" });

    expect(reload.audiobookshelf).toHaveBeenCalledTimes(1);
    expect(reload.lidarr).not.toHaveBeenCalled();
    expect(reload.fanart).not.toHaveBeenCalled();
});

it("a changed fanart key reloads fanart alone", async () => {
    await saveSystemSettings({ fanartApiKey: "fa-key" });

    expect(reload.fanart).toHaveBeenCalledTimes(1);
    expect(reload.lidarr).not.toHaveBeenCalled();
    expect(reload.audiobookshelf).not.toHaveBeenCalled();
});

it("turning Audiobookshelf on or off is seen by the feature list at once", async () => {
    await saveSystemSettings({ audiobookshelfEnabled: true });
    expect((await featureDetection.getFeatures()).audiobookshelfEnabled).toBe(true);

    await saveSystemSettings({ audiobookshelfEnabled: false });
    expect((await featureDetection.getFeatures()).audiobookshelfEnabled).toBe(false);
});

describe("Soulseek", () => {
    it.each([
        ["on-switch", { soulseekEnabled: true }],
        ["username", { soulseekUsername: "someone-else" }],
        ["password", { soulseekPassword: "secret" }],
        ["mode", { soulseekMode: "slskd" as const }],
        ["slskd address", { slskdUrl: "http://slskd.test:5030" }],
        ["slskd key", { slskdApiKey: "slskd-key" }],
        ["download folder", { soulseekDownloadPath: "/downloads" }],
    ])("reconnects when its %s changes", async (_name, change) => {
        await saveSystemSettings(change);

        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it("does not reconnect when an unrelated field changes, or its own are sent back as they were", async () => {
        await saveSystemSettings({ soulseekUsername: "user", soulseekMode: "p2p", slskdUrl: "", soulseekDownloadPath: "", transcodeCacheMaxGb: 30, fanartEnabled: true });

        expect(reconnect).not.toHaveBeenCalled();
    });

    it("a save does not wait for the reconnect to finish", async () => {
        reconnect.mockReturnValueOnce(new Promise<void>(() => {}));
        const held = Symbol("held");

        const outcome = await Promise.race([
            saveSystemSettings({ soulseekPassword: "secret" }),
            new Promise<symbol>((resolve) => setTimeout(() => resolve(held), 500)),
        ]);

        expect(outcome).toEqual(["soulseekPassword"]);
        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it("a failed reconnect does not fail the save", async () => {
        reconnect.mockRejectedValueOnce(new Error("soulseek is down"));

        await expect(saveSystemSettings({ soulseekPassword: "secret" })).resolves.toEqual(["soulseekPassword"]);
    });
});
