// Issue #238: acquisition is operator-only by default, and a Settings toggle
// opens it to members — acquire only. On the real database with real tokens;
// no mocked middleware. Deleting keeps its own requireAdmin and is untouched.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { requireAuth, requireAcquirePermission, generateToken } from "../../middleware/auth";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import systemSettingsRoutes from "../systemSettings";
import playlistRoutes from "../playlists";
import discoverRoutes from "../discover";
import spotifyRoutes from "../spotify";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-acquire";
const USER = `${P}-member`;
const ADMIN = `${P}-admin`;

function app() {
    const a = express();
    a.use(express.json());
    // The gate as every acquire route mounts it, plus a stub of what sits
    // behind it: if the guard passes, this handler runs.
    a.post("/acquire-test", requireAuth, requireAcquirePermission, (_req, res) => {
        res.json({ acquired: true });
    });
    a.use("/system-settings", systemSettingsRoutes);
    a.use("/playlists", requireAuth, playlistRoutes);
    a.use("/discover", requireAuth, discoverRoutes);
    a.use("/spotify", requireAuth, spotifyRoutes);
    return a;
}

const as = (id: string, role: "user" | "admin") =>
    `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

const setToggle = async (allowMemberAcquire: boolean) => {
    await prisma.systemSettings.upsert({
        where: { id: "default" },
        create: { id: "default", allowMemberAcquire },
        update: { allowMemberAcquire },
    });
    invalidateSystemSettingsCache();
};

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    await setToggle(false);
});

afterAll(async () => {
    // Leave the shared singleton exactly as a fresh install would have it.
    await setToggle(false);
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await closeEngineConnections();
});

describe("acquire permission gate (#238)", () => {
    it("members get 403 while the toggle is off", async () => {
        const res = await request(app())
            .post("/acquire-test")
            .set("Authorization", as(USER, "user"))
            .send({});
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/operator-only/);
    });

    it("admins pass regardless of the toggle", async () => {
        const res = await request(app())
            .post("/acquire-test")
            .set("Authorization", as(ADMIN, "admin"))
            .send({});
        expect(res.status).toBe(200);
    });

    it("no token is still 401, not a permission hint", async () => {
        const res = await request(app()).post("/acquire-test").send({});
        expect(res.status).toBe(401);
    });

    it("the toggle opens acquire for members — and the server says so in public-config", async () => {
        const member = await request(app())
            .get("/system-settings/public-config")
            .set("Authorization", as(USER, "user"));
        expect(member.status).toBe(200);
        expect(member.body.canAcquire).toBe(false);

        await setToggle(true);

        const afterToggle = await request(app())
            .post("/acquire-test")
            .set("Authorization", as(USER, "user"))
            .send({});
        expect(afterToggle.status).toBe(200);

        const memberAfter = await request(app())
            .get("/system-settings/public-config")
            .set("Authorization", as(USER, "user"));
        expect(memberAfter.body.canAcquire).toBe(true);

        const admin = await request(app())
            .get("/system-settings/public-config")
            .set("Authorization", as(ADMIN, "admin"));
        expect(admin.body.canAcquire).toBe(true);

        await setToggle(false);
    });

    it("the real routes that start downloads refuse a member while the toggle is off", async () => {
        const member = (path: string, body: object = {}) =>
            request(app()).post(path).set("Authorization", as(USER, "user")).send(body);
        for (const res of [
            await member("/playlists/any/pending/any/retry"),
            await member("/discover/generate"),
            await member("/spotify/import", { spotifyPlaylistId: "x", playlistName: "p", albumMbidsToDownload: ["mbid"], previewJobId: "none" }),
        ]) {
            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/operator-only/);
        }
        // Importing without downloading passes the gate (and stops at the missing preview).
        const matchOnly = await member("/spotify/import", { spotifyPlaylistId: "x", playlistName: "p", albumMbidsToDownload: [], previewJobId: "none" });
        expect(matchOnly.status).toBe(400);
    });

    it("the eight acquire routes all carry the gate", async () => {
        // Mount-point audit: each door mounts requireAcquirePermission before
        // its handler. Read from source so a future route refactor fails here.
        const fs = require("fs");
        const path = require("path");
        const routesDir = path.join(__dirname, "..");
        const doors: Array<[string, RegExp]> = [
            ["soulseek.ts", /"\/download"[\s\S]{0,40}requireAcquirePermission/],
            ["downloads.ts", /router\.post\("\/", requireAcquirePermission/],
            ["notifications.ts", /"\/downloads\/:id\/retry"[\s\S]{0,40}requireAcquirePermission/],
            ["playlists.ts", /"\/:id\/pending\/retry-all", requireAcquirePermission/],
            ["releases.ts", /"\/download\/:albumMbid", requireAcquirePermission/],
            ["discover.ts", /"\/retry-unavailable", requireAcquirePermission/],
            ["discover.ts", /"\/generate", requireAcquirePermission/],
            ["playlists.ts", /"\/:id\/pending\/:trackId\/retry", requireAcquirePermission/],
        ];
        for (const [file, pattern] of doors) {
            const src = fs.readFileSync(path.join(routesDir, file), "utf8");
            expect({ file, gated: pattern.test(src) }).toEqual({ file, gated: true });
        }
    });
});
