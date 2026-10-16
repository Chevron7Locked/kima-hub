// Issue #238: acquisition is operator-only by default, and a Settings toggle
// opens it to members — acquire only. On the real database with real tokens;
// no mocked middleware. Deleting keeps its own requireAdmin and is untouched.

// Only so the Soulseek router can load: its service connects to the network as it is created.
jest.mock("../../services/soulseek", () => ({ soulseekService: {} }));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { requireAuth, requireAcquirePermission, generateToken } from "../../middleware/auth";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import systemSettingsRoutes from "../systemSettings";
import playlistRoutes from "../playlists";
import discoverRoutes from "../discover";
import spotifyRoutes from "../spotify";
import soulseekRoutes from "../soulseek";
import downloadRoutes from "../downloads";
import notificationRoutes from "../notifications";
import releaseRoutes from "../releases";
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

    it("exactly these eight routes start downloads behind the gate", () => {
        // Read from each router's own route table and matched on the gate function itself, so a gate dropped in a
        // refactor, left in a comment or put on the wrong route fails here, and a new gated route must be listed.
        // Downloads started outside a route (an import retrying its unmatched songs) are tested where they start.
        const routers: Array<[string, express.Router]> = [
            ["soulseek", soulseekRoutes],
            ["downloads", downloadRoutes],
            ["notifications", notificationRoutes],
            ["playlists", playlistRoutes],
            ["releases", releaseRoutes],
            ["discover", discoverRoutes],
        ];
        // A router layer as Express builds it; its published types leave out a route's methods.
        type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
        const gated = routers.flatMap(([name, router]) =>
            (router.stack as Layer[]).flatMap(({ route }) =>
                route?.stack.some((handler) => handler.handle === requireAcquirePermission)
                    ? [`${name} ${Object.keys(route.methods).join(",")} ${route.path}`]
                    : [],
            ),
        );
        expect(gated.sort()).toEqual([
            "discover post /generate",
            "discover post /retry-unavailable",
            "downloads post /",
            "notifications post /downloads/:id/retry",
            "playlists post /:id/pending/:trackId/retry",
            "playlists post /:id/pending/retry-all",
            "releases post /download/:albumMbid",
            "soulseek post /download",
        ]);
    });
});
