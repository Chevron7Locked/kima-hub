// A right device-link code no longer hands out a key by itself: the app's request is held until the signed-in owner of
// the code approves it. Real database, real routes, requests shaped as the iOS app sends them ({code, deviceName}, no auth).

import express from "express";
import request from "supertest";
import bcrypt from "bcrypt";
import { prisma } from "../../utils/db";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import authRoutes from "../auth";
import deviceLinkRoutes from "../deviceLink";

jest.setTimeout(60_000);

const PREFIX = "zz-approval-";
const PASSWORD = "the right password";

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/device-link", deviceLinkRoutes);

let users = 0;
async function signedInUser() {
    users++;
    const username = `${PREFIX}${users}`;
    const user = await prisma.user.create({ data: { username, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    const { body } = await request(app).post("/api/auth/login").send({ username, password: PASSWORD });
    return { id: user.id, token: body.token as string };
}

let codes = 0;
const freshCode = (userId: string) =>
    prisma.deviceLinkCode.create({
        data: { code: `ZY${String(++codes).padStart(4, "0")}`, userId, expiresAt: new Date(Date.now() + 300_000) },
    });

// The app's request: JSON {code, deviceName}, no auth.
const appVerify = (code: string, deviceName: unknown = "an iphone") =>
    request(app).post("/api/device-link/verify").send({ code, deviceName });

// Sends the app's request now, instead of when it is first awaited.
const startAppVerify = (code: string, deviceName?: unknown) => appVerify(code, deviceName).then((res) => res);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const approve = (token: string, code: string) =>
    request(app).post(`/api/device-link/approve/${code}`).set("Authorization", `Bearer ${token}`);

const deny = (token: string, code: string) =>
    request(app).post(`/api/device-link/deny/${code}`).set("Authorization", `Bearer ${token}`);

const status = (code: string, token?: string) => {
    const req = request(app).get(`/api/device-link/status/${code}`);
    return token ? req.set("Authorization", `Bearer ${token}`) : req;
};

afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await closeEngineConnections();
});

describe("a wrong code", () => {
    it("gets 404 at once", async () => {
        await freshCode((await signedInUser()).id);
        const started = Date.now();

        const res = await appVerify("WRONG9");

        expect(res.status).toBe(404);
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

describe("a right code", () => {
    it("holds the app's request with no reply, and the owner's approval is what lets the key out", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        let replied = false;

        const held = appVerify(code).then((res) => {
            replied = true;
            return res;
        });
        await sleep(1500);
        expect(replied).toBe(false);

        expect((await approve(owner.token, code)).status).toBe(200);
        const res = await held;

        expect(res.status).toBe(200);
        expect(res.body.apiKey).toBeTruthy();
    });

    it("after approval answers in the shape the app expects, the key works, and the code is used", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        const held = startAppVerify(code, "kevin's iphone");
        await sleep(1000);
        await approve(owner.token, code);

        const res = await held;

        expect(res.body).toEqual({
            success: true,
            apiKey: expect.any(String),
            userId: owner.id,
            username: expect.stringContaining(PREFIX),
        });
        const devices = await request(app).get("/api/device-link/devices").set("X-API-Key", res.body.apiKey);
        expect(devices.status).toBe(200);
        expect(devices.body.map((d: { name: string }) => d.name)).toContain("kevin's iphone");
        const again = await appVerify(code);
        expect(again.status).toBe(400);
        expect(again.body.error).toBe("Code already used");
    });

    it("is refused with 403 when the owner denies it, and the code is gone", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        const held = startAppVerify(code);
        await sleep(1000);

        expect((await deny(owner.token, code)).status).toBe(200);
        const res = await held;

        expect(res.status).toBe(403);
        expect(res.body.error).toEqual(expect.any(String));
        expect(res.body.apiKey).toBeUndefined();
        const retry = await appVerify(code);
        expect(retry.status).toBe(404);
    });

    it("is refused with 408 after 45 seconds with no answer, and the code still works", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        const started = Date.now();

        const res = await startAppVerify(code);

        expect(res.status).toBe(408);
        expect(res.body.error).toEqual(expect.any(String));
        expect(Date.now() - started).toBeGreaterThanOrEqual(44_500);
        const second = startAppVerify(code);
        await sleep(1000);
        await approve(owner.token, code);
        expect((await second).status).toBe(200);
    });

    it("refuses a second request for the same code at once with 409, and the first keeps waiting", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        const first = startAppVerify(code, "the first");
        await sleep(1000);

        const second = await Promise.race([startAppVerify(code, "the second"), sleep(3000).then(() => "still held")]);

        expect(second).toMatchObject({ status: 409 });
        await approve(owner.token, code);
        const res = await first;
        expect(res.status).toBe(200);
        const devices = await request(app).get("/api/device-link/devices").set("X-API-Key", res.body.apiKey);
        expect(devices.body.map((d: { name: string }) => d.name)).toEqual(["the first"]);
    });
});

describe("wrong codes", () => {
    it("are not capped across the server, so a stranger cannot block linking", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);

        for (let i = 0; i < 40; i++) expect((await appVerify("WRONG9")).status).toBe(404);

        const held = startAppVerify(code);
        await sleep(1000);
        expect((await approve(owner.token, code)).status).toBe(200);
        expect((await held).status).toBe(200);
    });
});

describe("an app that goes away while its request is held", () => {
    it("leaves nothing waiting: the owner sees no prompt, approve finds nothing, and the code works for a new request", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        const gone = request(app).post("/api/device-link/verify").send({ code, deviceName: "the gone one" });
        gone.then(
            () => undefined,
            () => undefined,
        );
        await sleep(1000);
        expect((await status(code, owner.token)).body.status).toBe("waiting");

        gone.abort();
        await sleep(500);

        expect((await status(code, owner.token)).body.status).toBe("pending");
        expect((await approve(owner.token, code)).status).toBe(404);
        const next = startAppVerify(code, "the next one");
        await sleep(1000);
        expect((await status(code, owner.token)).body).toMatchObject({ status: "waiting", deviceName: "the next one" });
        expect((await approve(owner.token, code)).status).toBe(200);
        expect((await next).status).toBe(200);
    });
});

describe("the device name a stranger sends", () => {
    it("falls back to 'Mobile Device' when it is not a string, on the page and on the key", async () => {
        const owner = await signedInUser();
        for (const odd of [{ a: 1 }, 42, ["x"], true]) {
            const { code } = await freshCode(owner.id);
            const held = startAppVerify(code, odd);
            await sleep(700);

            expect((await status(code, owner.token)).body.deviceName).toBe("Mobile Device");
            await approve(owner.token, code);
            const res = await held;
            const devices = await request(app).get("/api/device-link/devices").set("X-API-Key", res.body.apiKey);
            expect(devices.body.map((d: { name: string }) => d.name)).toEqual(["Mobile Device"]);
            await request(app).delete(`/api/device-link/devices/${devices.body[0].id}`).set("Authorization", `Bearer ${owner.token}`);
        }
    });
});

describe("a very long device name", () => {
    it("is cut to 100 characters, on the page and on the key", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        const held = startAppVerify(code, "a".repeat(5000));
        await sleep(700);

        expect((await status(code, owner.token)).body.deviceName).toBe("a".repeat(100));
        await approve(owner.token, code);
        const res = await held;
        const devices = await request(app).get("/api/device-link/devices").set("X-API-Key", res.body.apiKey);
        expect(devices.body.map((d: { name: string }) => d.name)).toEqual(["a".repeat(100)]);
    });
});

describe("a code that expires while its request waits", () => {
    it("is refused as expired when the owner approves too late, and no key is given", async () => {
        const owner = await signedInUser();
        const { code } = await prisma.deviceLinkCode.create({
            data: { code: "ZXPIRE", userId: owner.id, expiresAt: new Date(Date.now() + 3000) },
        });
        const held = startAppVerify(code);
        await sleep(3500);

        expect((await approve(owner.token, code)).status).toBe(200);
        const res = await held;

        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Code expired");
        expect(res.body.apiKey).toBeUndefined();
        expect((await status(code, owner.token)).body.status).toBe("expired");
    });
});

describe("approve and deny", () => {
    it("work only for the owner of the code, and a refused try leaves the request waiting", async () => {
        const owner = await signedInUser();
        const stranger = await signedInUser();
        const { code } = await freshCode(owner.id);
        let replied = false;
        const held = startAppVerify(code).then((res) => {
            replied = true;
            return res;
        });
        await sleep(1000);

        expect((await request(app).post(`/api/device-link/approve/${code}`)).status).toBe(401);
        expect((await request(app).post(`/api/device-link/deny/${code}`)).status).toBe(401);
        expect((await approve(stranger.token, code)).status).toBe(404);
        expect((await deny(stranger.token, code)).status).toBe(404);
        await sleep(500);
        expect(replied).toBe(false);

        expect((await approve(owner.token, code)).status).toBe(200);
        expect((await held).status).toBe(200);
    });
});

describe("the status check", () => {
    it("needs sign-in, and answers only the owner of the code; anyone else gets 404", async () => {
        const owner = await signedInUser();
        const stranger = await signedInUser();
        const { code } = await freshCode(owner.id);

        expect((await status(code)).status).toBe(401);
        expect((await status(code, stranger.token)).status).toBe(404);
        const mine = await status(code, owner.token);
        expect(mine.status).toBe(200);
        expect(mine.body.status).toBe("pending");
    });

    it("shows the name of the device that is waiting, and only while one waits", async () => {
        const owner = await signedInUser();
        const { code } = await freshCode(owner.id);
        const held = startAppVerify(code, "kevin's iphone");
        await sleep(1000);

        const waiting = await status(code, owner.token);

        expect(waiting.body).toMatchObject({ status: "waiting", deviceName: "kevin's iphone" });
        await approve(owner.token, code);
        await held;
        expect((await status(code, owner.token)).body.status).toBe("used");
    });
});
