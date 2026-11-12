/**
 * The live-listening switch in user settings: offered only to the public user,
 * and saving it hides or shows their live trip at once. Real router, real
 * liveListening and real database; the public user is found by username.
 */
jest.mock("../../config", () => ({
    config: { publicVibe: { token: "t".repeat(32), username: "live_share_pub" } },
}));
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] ?? "live_share_pub" };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../services/staleJobCleanup", () => ({ staleJobCleanupService: {} }));

import express from "express";
import request from "supertest";
import settingsRouter from "../settings";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { getLiveState, setLiveHidden } from "../../services/liveListening";

const PUBLIC = "live_share_pub";
const OTHER = "live_share_other";

const app = express();
app.use(express.json());
app.use("/api/settings", settingsRouter);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [PUBLIC, OTHER] } } });
    for (const id of [PUBLIC, OTHER]) {
        await prisma.user.create({ data: { id, username: id, passwordHash: "x" } });
    }
});

afterAll(async () => {
    // UserSettings go with their user.
    await prisma.user.deleteMany({ where: { id: { in: [PUBLIC, OTHER] } } });
});

beforeEach(async () => {
    await prisma.userSettings.deleteMany({ where: { userId: { in: [PUBLIC, OTHER] } } });
    for (const userId of [PUBLIC, OTHER]) {
        await prisma.userSettings.create({ data: { userId, playbackQuality: "original", shareLiveListening: true } });
    }
    setLiveHidden(false);
});

const stored = (userId: string) => prisma.userSettings.findUniqueOrThrow({ where: { userId } });

describe("live sharing setting", () => {
    it("is offered to the public user", async () => {
        const res = await request(app).get("/api/settings");
        expect(res.body).toMatchObject({ liveSharingAvailable: true, shareLiveListening: true });
    });

    it("is not offered to anyone else", async () => {
        const res = await request(app).get("/api/settings").set("x-user", OTHER);
        expect(res.body.liveSharingAvailable).toBe(false);
    });

    it("is not offered when the public feed is off", async () => {
        const saved = config.publicVibe;
        (config as any).publicVibe = null;
        try {
            const res = await request(app).get("/api/settings");
            expect(res.body.liveSharingAvailable).toBe(false);
        } finally {
            (config as any).publicVibe = saved;
        }
    });

    it("hides the live trip as soon as the public user turns it off", async () => {
        const res = await request(app).post("/api/settings").send({ shareLiveListening: false });
        expect(res.status).toBe(200);
        expect((await stored(PUBLIC)).shareLiveListening).toBe(false);
        expect(getLiveState().status).toBe("hidden");
    });

    it("shows the live trip again when the public user turns it back on", async () => {
        await request(app).post("/api/settings").send({ shareLiveListening: false });
        await request(app).post("/api/settings").send({ shareLiveListening: true });
        expect(getLiveState().status).not.toBe("hidden");
    });

    it("leaves the live trip alone when someone else saves settings", async () => {
        const res = await request(app).post("/api/settings").set("x-user", OTHER).send({ shareLiveListening: false });
        expect(res.status).toBe(200);
        expect((await stored(OTHER)).shareLiveListening).toBe(false);
        expect(getLiveState().status).not.toBe("hidden");
    });

    it("leaves the live trip alone when the switch is not part of the save", async () => {
        const res = await request(app).post("/api/settings").send({ playbackQuality: "high" });
        expect(res.status).toBe(200);
        expect((await stored(PUBLIC)).playbackQuality).toBe("high");
        expect(getLiveState().status).not.toBe("hidden");
    });
});
