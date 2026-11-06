/**
 * Lidarr's health: a failed status call or a fresh database error in its log
 * pauses Lidarr with backoff and alerts admins once; recovery undoes both and
 * resumes held downloads.
 */

const lidarr = { get: jest.fn() };
jest.mock("../lidarrClient", () => ({
    ...jest.requireActual("../lidarrClient"),
    createLidarrClient: () => lidarr,
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ lidarrEnabled: true, lidarrUrl: "http://lidarr", lidarrApiKey: "key", unreadableFields: [] }),
}));
jest.mock("../sourcePauseController", () => ({
    sourcePauseController: { pause: jest.fn(), release: jest.fn() },
}));
jest.mock("../notificationService", () => ({
    notificationService: { notifyAdmins: jest.fn(), resolve: jest.fn() },
}));
jest.mock("../simpleDownloadManager", () => ({
    simpleDownloadManager: { resumeHeldDownloads: jest.fn().mockResolvedValue(0) },
}));

import type * as Health from "../lidarrHealth";

const LIDARR_UNHEALTHY = "LIDARR_UNHEALTHY";
let lidarrHealthMonitor: typeof Health.lidarrHealthMonitor;
let sourcePauseController: { pause: jest.Mock; release: jest.Mock };
let notificationService: { notifyAdmins: jest.Mock; resolve: jest.Mock };
let simpleDownloadManager: { resumeHeldDownloads: jest.Mock };

const minutes = (n: number) => n * 60_000;
const logs = (...records: Array<{ minutesAgo: number; message: string }>) => ({
    data: {
        records: records.map((r) => ({ time: new Date(Date.now() - minutes(r.minutesAgo)).toISOString(), message: r.message })),
    },
});
const healthy = (log = logs()) =>
    lidarr.get.mockImplementation(async (path: string) => (path === "/api/v1/log" ? log : { data: {} }));
const down = () => lidarr.get.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { isAxiosError: true }));

// A fresh monitor per test: its backoff deliberately survives brief recoveries.
beforeEach(async () => {
    jest.resetModules();
    ({ lidarrHealthMonitor } = require("../lidarrHealth"));
    ({ sourcePauseController } = require("../sourcePauseController"));
    ({ notificationService } = require("../notificationService"));
    ({ simpleDownloadManager } = require("../simpleDownloadManager"));
    healthy();
    await lidarrHealthMonitor.check();
    jest.clearAllMocks();
});

it("pauses Lidarr with backoff and alerts admins once while it is down", async () => {
    down();
    const delays = [];
    for (let i = 0; i < 5; i++) delays.push(await lidarrHealthMonitor.check());

    expect(delays).toEqual([1, 2, 5, 15, 15].map(minutes));
    expect(sourcePauseController.pause).toHaveBeenCalledTimes(5);
    expect(sourcePauseController.pause).toHaveBeenLastCalledWith("lidarr", expect.objectContaining({ code: LIDARR_UNHEALTHY }));
    expect(notificationService.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(notificationService.notifyAdmins).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Lidarr is unhealthy", groupKey: "lidarr-health" })
    );
    expect(lidarrHealthMonitor.getState()).toMatchObject({ status: "unhealthy", reason: "Lidarr did not answer: connect ECONNREFUSED" });
    expect(simpleDownloadManager.resumeHeldDownloads).not.toHaveBeenCalled();
});

it("recovers: lifts the pause, clears the alert, resumes held downloads", async () => {
    down();
    await lidarrHealthMonitor.check();
    healthy();

    expect(await lidarrHealthMonitor.check()).toBe(minutes(1));
    expect(sourcePauseController.release).toHaveBeenCalledWith("lidarr", LIDARR_UNHEALTHY);
    expect(notificationService.resolve).toHaveBeenCalledWith("lidarr-health");
    expect(simpleDownloadManager.resumeHeldDownloads).toHaveBeenCalled();
    expect(lidarrHealthMonitor.getState().status).toBe("ok");
});

it("keeps the backoff across a brief recovery", async () => {
    down();
    await lidarrHealthMonitor.check();
    healthy();
    await lidarrHealthMonitor.check();
    down();

    expect(await lidarrHealthMonitor.check()).toBe(minutes(2));
});

it("counts a new database error in Lidarr's log, once", async () => {
    healthy(logs({ minutesAgo: 0, message: "database disk image is malformed" }));
    await lidarrHealthMonitor.check();
    expect(lidarrHealthMonitor.getState()).toMatchObject({
        status: "unhealthy",
        reason: "Lidarr's database is failing: database disk image is malformed",
    });

    await lidarrHealthMonitor.check();
    expect(lidarrHealthMonitor.getState().status).toBe("ok");
});

it("ignores old and unrelated log errors", async () => {
    healthy(logs({ minutesAgo: 60, message: "database is locked" }, { minutesAgo: 0, message: "Indexer search failed" }));

    await lidarrHealthMonitor.check();
    expect(lidarrHealthMonitor.getState().status).toBe("ok");
    expect(sourcePauseController.pause).not.toHaveBeenCalled();
});
