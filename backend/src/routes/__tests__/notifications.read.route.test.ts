/**
 * Marking alerts read tells the user's other open tabs, so their trays and
 * unread counts refresh without a reload.
 */

jest.mock("../../middleware/auth", () => ({
    requireAcquirePermission: require("../../__tests__/helpers/acquireGateOff").acquireGateOff,
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: "nrd_user", role: "user" };
        next();
    },
}));

import express from "express";
import request from "supertest";
import notificationRoutes from "../notifications";
import { prisma } from "../../utils/db";
import { eventBus } from "../../services/eventBus";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const USER = "nrd_user";

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/notifications", notificationRoutes);
    return app;
}

const readEvents = (emit: jest.SpyInstance) =>
    emit.mock.calls.map(([e]) => e).filter((e) => e.type === "notification:read");

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.notification.deleteMany({ where: { userId: USER } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

it("tells other tabs when one alert is read", async () => {
    const row = await prisma.notification.create({ data: { userId: USER, type: "system", title: "Scan finished" } });
    const emit = jest.spyOn(eventBus, "emit");

    await request(makeApp()).post(`/notifications/${row.id}/read`).expect(200);

    expect(readEvents(emit)).toEqual([{ type: "notification:read", userId: USER, payload: { id: row.id } }]);
});

it("tells other tabs when every alert is read", async () => {
    await prisma.notification.create({ data: { userId: USER, type: "system", title: "Scan finished" } });
    const emit = jest.spyOn(eventBus, "emit");

    await request(makeApp()).post("/notifications/read-all").expect(200);

    expect(readEvents(emit)).toEqual([{ type: "notification:read", userId: USER, payload: {} }]);
    expect(await prisma.notification.count({ where: { userId: USER, read: false } })).toBe(0);
});
