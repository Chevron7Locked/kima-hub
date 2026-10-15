/**
 * GET /api/system/features tells the player whether to report what it plays for the public live
 * feed. The answer is isPublicListener's (tested in liveListening.test.ts); a lookup that fails
 * is "no", and never costs the player the other features.
 */

import express from "express";
import request from "supertest";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "u_owner", username: "t" };
        next();
    },
}));
jest.mock("../../services/featureDetection", () => ({
    featureDetection: {
        getFeatures: jest.fn().mockResolvedValue({ musicCNN: true, vibeEmbeddings: true, audiobookshelfEnabled: false }),
    },
}));
const mockIsPublicListener = jest.fn();
jest.mock("../../services/liveListening", () => ({
    isPublicListener: (userId: string) => mockIsPublicListener(userId),
}));
jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import systemRouter from "../system";

const app = express();
app.use("/system", systemRouter);

beforeEach(() => mockIsPublicListener.mockReset());

describe("GET /system/features: live reporting", () => {
    it("is on for the public listener, asked about the signed-in user", async () => {
        mockIsPublicListener.mockResolvedValue(true);

        const res = await request(app).get("/system/features");

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ musicCNN: true, vibeEmbeddings: true, liveReporting: true });
        expect(mockIsPublicListener).toHaveBeenCalledWith("u_owner");
    });

    it("is off for everyone else", async () => {
        mockIsPublicListener.mockResolvedValue(false);

        expect((await request(app).get("/system/features")).body).toMatchObject({ musicCNN: true, liveReporting: false });
    });

    it("a failed lookup is off, and the other features still answer", async () => {
        mockIsPublicListener.mockRejectedValue(new Error("connection terminated"));

        const res = await request(app).get("/system/features");

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ musicCNN: true, vibeEmbeddings: true, liveReporting: false });
    });
});
