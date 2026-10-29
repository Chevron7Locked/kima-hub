/**
 * The live-listening switch in user settings: offered only to the public user,
 * and saving it hides or shows their live trip at once.
 */
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const row = { userId: "public-user", playbackQuality: "original", shareLiveListening: true, listenbrainzToken: null };
jest.mock("../../utils/db", () => ({
    prisma: {
        userSettings: {
            findUnique: jest.fn(async () => row),
            upsert: jest.fn(async ({ update }: any) => ({ ...row, ...update })),
        },
    },
}));
jest.mock("../../config", () => require("./helpers/publicListener").publicVibeConfigMock());
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] ?? "public-user" };
        next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock("../../services/staleJobCleanup", () => ({ staleJobCleanupService: {} }));
// isPublicListener is faked in helpers/publicListener; the real check is tested in liveListening.test.ts.
jest.mock("../../services/liveListening", () => ({
    isPublicListener: require("./helpers/publicListener").fakeIsPublicListener,
    setLiveHidden: jest.fn(),
}));

import express from "express";
import request from "supertest";
import settingsRouter from "../settings";
import { config } from "../../config";
import { setLiveHidden } from "../../services/liveListening";

const app = express();
app.use(express.json());
app.use("/api/settings", settingsRouter);

beforeEach(() => jest.clearAllMocks());

describe("live sharing setting", () => {
    it("is offered to the public user", async () => {
        const res = await request(app).get("/api/settings");
        expect(res.body).toMatchObject({ liveSharingAvailable: true, shareLiveListening: true });
    });

    it("is not offered to anyone else", async () => {
        const res = await request(app).get("/api/settings").set("x-user", "someone-else");
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
        expect(setLiveHidden).toHaveBeenCalledWith(true);
    });

    it("leaves the live trip alone when someone else saves settings", async () => {
        await request(app).post("/api/settings").set("x-user", "someone-else").send({ shareLiveListening: false });
        expect(setLiveHidden).not.toHaveBeenCalled();
    });

    it("leaves the live trip alone when the switch is not part of the save", async () => {
        await request(app).post("/api/settings").send({ playbackQuality: "high" });
        expect(setLiveHidden).not.toHaveBeenCalled();
    });
});
