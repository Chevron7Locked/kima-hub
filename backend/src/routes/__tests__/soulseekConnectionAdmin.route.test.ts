// Connecting and disconnecting change the server's one Soulseek connection for every listener, so both need admin.
// Real database and real tokens; only the Soulseek client is replaced, since a test must not reach the network.

const mockDisconnect = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
jest.mock("../../services/soulseek", () => ({
    soulseekService: { disconnect: mockDisconnect, connect: mockConnect, isAvailable: jest.fn().mockResolvedValue(true) },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import soulseekRoutes from "../soulseek";

const P = "zz-slsk-connection";
const USER = `${P}-member`;
const ADMIN = `${P}-admin`;

const app = () => express().use(express.json()).use("/soulseek", soulseekRoutes);
const as = (id: string, role: "user" | "admin") =>
    `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await prisma.$disconnect();
});

beforeEach(() => {
    mockDisconnect.mockReset();
    mockConnect.mockClear();
});

describe("POST /soulseek/disconnect", () => {
    it("refuses a member and leaves the connection up", async () => {
        const res = await request(app()).post("/soulseek/disconnect").set("Authorization", as(USER, "user"));
        expect(res.status).toBe(403);
        expect(mockDisconnect).not.toHaveBeenCalled();
    });

    it("disconnects for an admin", async () => {
        const res = await request(app()).post("/soulseek/disconnect").set("Authorization", as(ADMIN, "admin"));
        expect(res.status).toBe(200);
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });
});

describe("POST /soulseek/connect", () => {
    it("refuses a member and leaves the connection alone", async () => {
        const res = await request(app()).post("/soulseek/connect").set("Authorization", as(USER, "user"));
        expect(res.status).toBe(403);
        expect(mockConnect).not.toHaveBeenCalled();
    });

    it("connects for an admin", async () => {
        const res = await request(app()).post("/soulseek/connect").set("Authorization", as(ADMIN, "admin"));
        expect(res.status).toBe(200);
        expect(mockConnect).toHaveBeenCalledTimes(1);
    });
});
