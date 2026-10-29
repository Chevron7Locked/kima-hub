/**
 * Downloading a release from the radar starts one job per album for the listener: a second tap, or two at once, reuse
 * it. A Discover job for the same album is not theirs, so it is never reused (Discover is only Discover). The job is
 * made by the acquisition service's own find-or-create; the acquisition itself is stood in for. Real database and
 * Redis lock.
 */
jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuthOrToken: (req: any, _res: any, next: any) => {
        req.user = { id: "rdl_user", role: "admin" };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { acquisitionService } from "../../services/acquisitionService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import releasesRoutes from "../releases";

const USER = "rdl_user";
const RG = "5b1b2c3d-1111-2222-3333-444455556666";
const app = express().use(express.json()).use("/releases", releasesRoutes);
const tap = () => request(app).post(`/releases/download/${RG}`).send({ artistName: "Low", albumTitle: "Hey What" });
const acquire = jest.spyOn(acquisitionService, "acquireAlbum");

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

beforeEach(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    acquire.mockReset().mockResolvedValue({ success: true } as any);
});

afterAll(async () => {
    acquire.mockRestore();
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

const jobs = () => prisma.downloadJob.findMany({ where: { userId: USER } });

it("starts one job, and a second tap reuses it", async () => {
    const first = await tap().expect(200);
    const second = await tap().expect(200);

    expect(first.body).toMatchObject({ success: true, message: "Download started for Low - Hey What" });
    expect(second.body).toMatchObject({ jobId: first.body.jobId, message: "Download already in progress for Low - Hey What" });
    expect(await jobs()).toHaveLength(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith(
        { albumTitle: "Hey What", artistName: "Low", mbid: RG },
        { userId: USER, existingJobId: first.body.jobId },
    );
});

it("makes one job for two taps at once", async () => {
    const [a, b] = await Promise.all([tap(), tap()]);
    expect(a.body.jobId).toBe(b.body.jobId);
    expect(await jobs()).toHaveLength(1);
    expect(acquire).toHaveBeenCalledTimes(1);
});

it("never joins a Discover download of the same album", async () => {
    const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(), targetSongCount: 10, status: "downloading" } });
    const discover = await prisma.downloadJob.create({
        data: { userId: USER, subject: "Low - Hey What", type: "album", targetMbid: RG, status: "processing", discoveryBatchId: batch.id, metadata: { downloadType: "discovery" } },
    });

    const res = await tap().expect(200);

    expect(res.body.jobId).not.toBe(discover.id);
    expect(res.body.message).toBe("Download started for Low - Hey What");
    const mine = await prisma.downloadJob.findUniqueOrThrow({ where: { id: res.body.jobId } });
    expect(mine.discoveryBatchId).toBeNull();
});

it("records the album on the job", async () => {
    const res = await tap().expect(200);
    const job = await prisma.downloadJob.findUniqueOrThrow({ where: { id: res.body.jobId } });
    expect(job).toMatchObject({ subject: "Low - Hey What", type: "album", targetMbid: RG, status: "pending" });
    expect(job.metadata).toEqual({ artistName: "Low", albumTitle: "Hey What", albumMbid: RG });
});
