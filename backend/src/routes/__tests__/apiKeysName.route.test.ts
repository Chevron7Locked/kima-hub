/**
 * A device name is cleaned in one place for both ways a device gets a key (the web page's key form and the
 * device-link code): trimmed, at most 100 characters, and what the log keeps is the cleaned name.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { logger } from "../../utils/logger";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountApi } from "../mounts";

const USER = "zz-apikey-name-user";
const bearer = `Bearer ${generateToken({ id: USER, username: USER, role: "admin", tokenVersion: 0 })}`;
const health = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok" });
};

const app = express();
app.use(express.json());
mountApi(app, { health, publicVibe: false });

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

afterEach(() => jest.restoreAllMocks());

describe("POST /api/api-keys names the device", () => {
    it("keeps at most 100 characters of the name", async () => {
        const res = await request(app).post("/api/api-keys").set("Authorization", bearer).send({ deviceName: "d".repeat(150) });

        expect(res.status).toBe(201);
        expect(res.body.name).toBe("d".repeat(100));
    });

    it("trims the name, and the log keeps the cleaned name, not the raw one", async () => {
        const debug = jest.spyOn(logger, "debug").mockImplementation(() => {});

        const res = await request(app)
            .post("/api/api-keys")
            .set("Authorization", bearer)
            .send({ deviceName: `   kitchen tablet${" ".repeat(200)}` });

        expect(res.status).toBe(201);
        expect(res.body.name).toBe("kitchen tablet");
        const lines = debug.mock.calls.map((call) => String(call[0]));
        expect(lines.some((line) => line.includes("API key created") && line.endsWith(": kitchen tablet"))).toBe(true);
    });
});
