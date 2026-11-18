/**
 * POST /discover/cleanup-lidarr, the admin's button for removing Discover's artists from Lidarr. A real run queues the
 * same artist job a clear asks for and answers at once, since Lidarr can take many seconds per artist. A dry run reads
 * Lidarr itself and answers with what would go; a Lidarr it cannot read is an error, never "no artists". Real test
 * database and Redis; Lidarr is a port nothing listens on.
 */

jest.mock("../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "dcl_admin", role: "admin" };
        next();
    };
    return { requireAuthOrToken: signIn, requireAuth: signIn, requireAdmin: signIn, requireAcquirePermission: signIn };
});
jest.mock("../../workers/queues", () => ({
    discoverQueue: { getJob: jest.fn(), add: jest.fn(), getActive: jest.fn().mockResolvedValue([]), getWaiting: jest.fn().mockResolvedValue([]) },
    scanQueue: { add: jest.fn() },
    discoverArtistsQueue: { getJobs: jest.fn(), add: jest.fn() },
}));

import request from "supertest";
import { prisma } from "../../utils/db";
import { discoverArtistsQueue } from "../../workers/queues";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { useLidarr, useNoLidarr } from "../../__tests__/helpers/lidarrSettings";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { deadPort, discoverApp } from "./helpers/discoverClear";

const queue = discoverArtistsQueue as unknown as { getJobs: jest.Mock; add: jest.Mock };
const app = discoverApp();

beforeEach(async () => {
    jest.clearAllMocks();
    queue.getJobs.mockResolvedValue([]);
    queue.add.mockResolvedValue({ id: "test-artists" });
    await useLidarr(`http://127.0.0.1:${await deadPort()}`);
});

afterAll(async () => {
    await useNoLidarr();
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("POST /discover/cleanup-lidarr", () => {
    it("queues the artist job and answers at once, without asking Lidarr inside the request", async () => {
        const res = await request(app).post("/discover/cleanup-lidarr?dryRun=false");

        expect(res.status).toBe(202);
        expect(res.body).toEqual({ success: true, dryRun: false, started: true });
        expect(queue.add).toHaveBeenCalledTimes(1);
        expect(queue.add.mock.calls[0][0]).toBe("remove-artists");
    });

    it("answers a dry run Lidarr could not be read for with the reason, never an empty list", async () => {
        expectLog("warn");

        const res = await request(app).post("/discover/cleanup-lidarr");

        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/^Discover's artists could not be read from Lidarr: .*ECONNREFUSED/);
        expect(res.body.removed).toBeUndefined();
        expect(queue.add).not.toHaveBeenCalled();
    });

    it("refuses both kinds when Lidarr is not set up", async () => {
        await useNoLidarr();

        for (const dryRun of ["true", "false"]) {
            const res = await request(app).post(`/discover/cleanup-lidarr?dryRun=${dryRun}`);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe("Lidarr not configured");
        }
        expect(queue.add).not.toHaveBeenCalled();
    });
});
