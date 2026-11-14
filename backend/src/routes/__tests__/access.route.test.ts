// Who may reach a route is declared where it is mounted, and a mount that declares nothing refuses everything. The
// route-listing test reads every mounted route with its declared family; the rest go through a real app, on the real
// database with real tokens.

import express, { Router } from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { listRoutes, mountRoute, parseRouteKey, type AccessFamily, type Mount, type RouteListing } from "../access";
import { apiMounts, mountApi, mountQueueBoardSlot, QUEUE_BOARD_PATH } from "../mounts";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAccess } from "../mountAccess";
import { createBullBoard } from "@bull-board/api";
import { ExpressAdapter } from "@bull-board/express";

const P = "zz-access";
const MEMBER = `${P}-member`;
const ADMIN = `${P}-admin`;
const as = (id: string, role: "user" | "admin") =>
    `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;
const tokenOf = (id: string, role: "user" | "admin") =>
    generateToken({ id, username: id, role, tokenVersion: 0 });

const health = (_req: express.Request, res: express.Response) => {
    res.json({ status: "ok" });
};
const options = { health, publicVibe: true };
const FAMILIES: AccessFamily[] = ["public", "signed-in", "admin", "internal", "webhook", "share-token", "subsonic"];

const key = (row: RouteListing) => `${row.method} ${row.mount}${row.path === "/" ? "" : row.path}`;
const inFamily = (rows: RouteListing[], family: AccessFamily) => rows.filter((r) => r.family === family).map(key).sort();

const appWithServer = () => {
    const app = express();
    app.use(express.json());
    mountApi(app, { health, publicVibe: false });
    return app;
};

beforeAll(async () => {
    await prisma.user.create({ data: { id: MEMBER, username: MEMBER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
    await closeEngineConnections();
});

describe("a mount with no declaration refuses everything", () => {
    it("answers every method with a refusal and never reaches the router", async () => {
        expectLog("error");
        const reached = jest.fn();
        const router = Router().all("*", (_req, res) => {
            reached();
            res.json({ secret: true });
        });
        const app = express();
        mountRoute(app, { path: "/api/forgotten", router });

        for (const method of ["get", "post", "put", "delete"] as const) {
            const res = await request(app)[method]("/api/forgotten/anything");
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ error: "No access is declared for /api/forgotten" });
        }
        expect(reached).not.toHaveBeenCalled();
    });

    it("a mount that declares a family reaches its router", async () => {
        const app = express();
        mountRoute(app, { path: "/api/open", router: Router().get("/", (_req, res) => res.json({ ok: true })), access: { family: "public" } });
        expect((await request(app).get("/api/open")).body).toEqual({ ok: true });
    });
});

describe("the route listing", () => {
    let rows: RouteListing[];
    beforeAll(async () => {
        rows = await listRoutes(apiMounts(options));
    });

    it("lists every route, each in a declared family", () => {
        expect(rows.length).toBeGreaterThan(300);
        for (const row of rows) expect(FAMILIES).toContain(row.family);
    });

    it("fails when a mount loses its declaration", async () => {
        const without = apiMounts(options).map((m): Mount => (m.path === "/api/plays" ? { ...m, access: undefined } : m));
        const undeclared = (await listRoutes(without)).filter((r) => r.family === null);
        expect(undeclared.map(key)).toEqual(["POST /api/plays"]);
    });

    it("fails when a route's own declaration is removed", async () => {
        const without = apiMounts(options).map((m): Mount =>
            m.path === "/api/system-settings" ? { ...m, access: { family: "admin" } } : m,
        );
        const after = await listRoutes(without);
        expect(inFamily(rows, "signed-in")).toContain("GET /api/system-settings/public-config");
        expect(inFamily(after, "signed-in")).not.toContain("GET /api/system-settings/public-config");
    });

    it("every route a mount singles out is a route its router has", () => {
        const routes = new Set(rows.map((r) => `${r.method} ${r.mount} ${r.path}`));
        for (const mount of apiMounts(options)) {
            const named = [
                ...Object.keys(mount.access?.routes ?? {}),
                ...(Array.isArray(mount.access?.urlToken) ? mount.access.urlToken : []),
            ];
            for (const route of named) {
                const { method, path } = parseRouteKey(route);
                expect(`${route} on ${mount.path}: ${routes.has(`${method} ${mount.path} ${path}`)}`).toBe(`${route} on ${mount.path}: true`);
            }
        }
    });

    it("every mounted path has its access declared, and every declaration has a mount", () => {
        const mounted = apiMounts(options).map((m) => m.path);
        expect(mounted.filter((path) => !mountAccess[path])).toEqual([]);
        // The queue dashboard is mounted when the workers start, not with the rest, and is no router of ours to list.
        const lateMounts = [QUEUE_BOARD_PATH];
        expect(Object.keys(mountAccess).filter((path) => !mounted.includes(path) && !lateMounts.includes(path))).toEqual([]);
        expect(mountAccess[QUEUE_BOARD_PATH]?.access.family).toBe("admin");
    });

    it("no router guards its own routes: access is declared at the mount only", () => {
        const guards = new Set(["requireAuth", "requireAuthOrToken", "requireAdmin"]);
        const found: string[] = [];
        const walk = (mount: string, stack: Array<{ name: string; route?: { stack: Array<{ name: string }> }; handle: { stack?: any[] } }>) => {
            for (const layer of stack) {
                if (guards.has(layer.name)) found.push(`${mount} ${layer.name}`);
                for (const inner of layer.route?.stack ?? []) if (guards.has(inner.name)) found.push(`${mount} ${inner.name}`);
                if (layer.handle.stack) walk(mount, layer.handle.stack);
            }
        };
        for (const mount of apiMounts(options)) {
            const stack = (mount.router as unknown as { stack?: any[] }).stack;
            if (stack) walk(mount.path, stack);
        }
        expect(found).toEqual([]);
    });

    it("the routes that take a query-string token are exactly these", () => {
        const byMount = (path: string) =>
            rows.filter((r) => r.urlToken && r.mount === path).map((r) => `${r.method} ${r.path}`).sort();
        expect(byMount("/api/podcasts")).toEqual(
            [
                "GET /categories",
                "GET /charts",
                "GET /discover/top",
                "GET /discover/genres",
                "GET /discover/genre/:genreId",
                "GET /preview/:itunesId/snippet",
                "GET /:id/similar",
                "GET /:id/cover",
                "GET /episodes/:episodeId/cover",
                "GET /:podcastId/episodes/:episodeId/stream",
            ].sort(),
        );
        expect(byMount("/api/stats")).toEqual([]);
    });

    it("the routes outside signed-in and admin are exactly these", () => {
        expect(inFamily(rows, "public")).toEqual(
            [
                "GET /api/audiobooks/:id/cover",
                "OPTIONS /api/audiobooks/:id/cover",
                "GET /api/events",
                "GET /health",
                "GET /api/health",
                "POST /api/auth/login",
                "POST /api/auth/logout",
                "POST /api/auth/refresh",
                "GET /api/onboarding/status",
                "POST /api/onboarding/register",
                "POST /api/device-link/verify",
            ].sort(),
        );
        expect(inFamily(rows, "internal")).toEqual(
            [
                "POST /api/analysis/vibe/failure",
                "POST /api/analysis/vibe/success",
                ...rows.filter((r) => r.mount === "/api/public/vibe").map(key),
            ].sort(),
        );
        expect(inFamily(rows, "webhook")).toEqual(["GET /api/webhooks/lidarr/verify", "POST /api/webhooks/lidarr"]);
        expect(inFamily(rows, "share-token")).toEqual(
            [
                "GET /api/share/:token",
                "GET /api/share/:token/cover-art/:coverArtId",
                "GET /api/share/:token/stream/:trackId",
            ].sort(),
        );
        expect(new Set(rows.filter((r) => r.family === "subsonic").map((r) => r.mount))).toEqual(new Set(["/rest"]));
    });
});

describe("the declared families are enforced in front of the routers", () => {
    it("a signed-in route refuses a stranger and takes a member", async () => {
        const app = appWithServer();
        expect((await request(app).get("/api/stats/hour")).status).toBe(401);
        expect((await request(app).get("/api/stats/hour").set("Authorization", as(MEMBER, "user"))).status).not.toBe(401);
    });

    it("a path that is no route is refused to a stranger too, not answered not-found", async () => {
        const res = await request(appWithServer()).get("/api/plays/no-such-route");
        expect(res.status).toBe(401);
    });

    it("an admin route refuses a stranger and a member, and takes an admin", async () => {
        const app = appWithServer();
        expect((await request(app).get("/api/system-settings")).status).toBe(401);
        expect((await request(app).get("/api/system-settings").set("Authorization", as(MEMBER, "user"))).status).toBe(403);
        expect((await request(app).get("/api/system-settings").set("Authorization", as(ADMIN, "admin"))).status).toBe(200);
    });

    it("a route that differs from its router answers as its own family", async () => {
        const app = appWithServer();
        // The public config inside the admin system settings takes any signed-in person.
        expect((await request(app).get("/api/system-settings/public-config")).status).toBe(401);
        expect((await request(app).get("/api/system-settings/public-config").set("Authorization", as(MEMBER, "user"))).status).toBe(200);
        // The enrichment pause inside the signed-in enrichment router is for admins.
        expect((await request(app).post("/api/enrichment/pause").set("Authorization", as(MEMBER, "user"))).status).toBe(403);
        // The audiobook cover answers without a session; its neighbours do not.
        expect((await request(app).get("/api/audiobooks/none/cover")).status).not.toBe(401);
        expect((await request(app).get("/api/audiobooks/none")).status).toBe(401);
    });

    it("sign-in and health need no session", async () => {
        const app = appWithServer();
        expect((await request(app).post("/api/auth/login").send({})).status).toBe(400);
        expect((await request(app).get("/health")).body).toEqual({ status: "ok" });
        expect((await request(app).get("/api/health")).body).toEqual({ status: "ok" });
    });

    it("a streaming mount takes the token in the address, the others do not", async () => {
        const app = appWithServer();
        const token = tokenOf(MEMBER, "user");
        expect((await request(app).get(`/api/downloads/failed?token=${token}`)).status).toBe(200);
        expect((await request(app).get(`/api/stats/hour?token=${token}`)).status).toBe(401);
    });

    it("podcast images and audio take the token in the address, its other routes do not", async () => {
        const app = appWithServer();
        const token = tokenOf(MEMBER, "user");
        // The cover and the stream are reached with the token; the show list is not.
        expect((await request(app).get(`/api/podcasts/none/cover?token=${token}`)).status).not.toBe(401);
        expect((await request(app).get(`/api/podcasts/none/episodes/none/stream?token=${token}`)).status).not.toBe(401);
        expect((await request(app).get(`/api/podcasts?token=${token}`)).status).toBe(401);
        expect((await request(app).get(`/api/podcasts/none/cover`)).status).toBe(401);
    });

    it("a machine route answers by its own secret, not by a session", async () => {
        const app = appWithServer();
        const res = await request(app).post("/api/analysis/vibe/failure").send({ trackId: "t" });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Forbidden" });
    });

    it("the webhook answers a caller with no session", async () => {
        const res = await request(appWithServer()).get("/api/webhooks/lidarr/verify");
        expect(res.status).toBe(200);
    });

    it("the metrics are for admins and counted once against the runaway limit", async () => {
        const app = appWithServer();
        expect((await request(app).get("/api/metrics")).status).toBe(401);
        expect((await request(app).get("/api/metrics").set("Authorization", as(MEMBER, "user"))).status).toBe(403);
        const first = await request(app).get("/api/metrics").set("Authorization", as(ADMIN, "admin"));
        expect(first.status).toBe(200);
        const second = await request(app).get("/api/metrics").set("Authorization", as(ADMIN, "admin"));
        expect(Number(second.headers["ratelimit-remaining"])).toBe(Number(first.headers["ratelimit-remaining"]) - 1);
        // A stranger counts too: the limit comes before the sign-in check.
        const stranger = await request(app).get("/api/metrics");
        expect(Number(stranger.headers["ratelimit-remaining"])).toBe(Number(second.headers["ratelimit-remaining"]) - 1);
    });

    it.each(["/api/library", "/api/enrichment"])("%s is closed by default: a route nobody listed is for admins", async (path) => {
        const declared = mountAccess[path].access;
        expect(declared.family).toBe("admin");
        // What the mount lets members use is exactly its listed exceptions.
        expect(new Set(Object.values(declared.routes ?? {}))).toEqual(new Set(["signed-in"]));

        const router = Router().get("/brand-new-route", (_req, res) => void res.json({ reached: true }));
        const app = express();
        mountRoute(app, { path, router, access: declared });
        expect((await request(app).get(`${path}/brand-new-route`).set("Authorization", as(MEMBER, "user"))).status).toBe(403);
        expect((await request(app).get(`${path}/brand-new-route`).set("Authorization", as(ADMIN, "admin"))).status).toBe(200);
    });

    it("the library and enrichment routes members can use are exactly these", async () => {
        const rows = await listRoutes(apiMounts(options));
        const memberRoutes = (mount: string) =>
            rows.filter((r) => r.mount === mount && r.family === "signed-in").map((r) => `${r.method} ${r.path}`).sort();
        expect(memberRoutes("/api/enrichment")).toEqual(
            ["GET /concurrency", "GET /failures", "GET /failures/counts", "GET /progress", "GET /status"].sort(),
        );
        expect(memberRoutes("/api/library")).toEqual(
            [
                "GET /album-cover/:mbid",
                "GET /albums",
                "GET /albums/:id",
                "GET /artist-counts/status",
                "GET /artists",
                "GET /artists/:id",
                "GET /artists/:id/play-tracks",
                "GET /cover-art/:id?",
                "GET /decades",
                "GET /genres",
                "GET /image-backfill/status",
                "GET /radio",
                "GET /radio/row",
                "GET /radio/stations",
                "GET /recently-added",
                "GET /recently-listened",
                "GET /scan/status/:jobId",
                "GET /tracks",
                "GET /tracks/:id",
                "GET /tracks/:id/lyrics",
                "GET /tracks/:id/stream",
                "GET /tracks/:id/waveform",
                "GET /tracks/shuffle",
                "POST /tracks/:id/prewarm",
            ].sort(),
        );
    });

    it("the queue dashboard is for admins: a stranger and a member are refused", async () => {
        const serverAdapter = new ExpressAdapter();
        serverAdapter.setBasePath(QUEUE_BOARD_PATH);
        createBullBoard({ queues: [], serverAdapter });
        const app = express();
        mountQueueBoardSlot(app)(serverAdapter.getRouter());

        const path = `${QUEUE_BOARD_PATH}/api/queues`;
        expect((await request(app).get(path)).status).toBe(401);
        expect((await request(app).get(path).set("Authorization", as(MEMBER, "user"))).status).toBe(403);
        expect((await request(app).get(`${QUEUE_BOARD_PATH}/`).set("Authorization", as(MEMBER, "user"))).status).toBe(403);
        expect((await request(app).get(path).set("Authorization", as(ADMIN, "admin"))).status).toBe(200);
    });

    it("the public vibe feed exists only when asked for", async () => {
        const off = await request(appWithServer()).get("/api/public/vibe/library");
        expect(off.status).toBe(404);
        const app = express();
        mountApi(app, { health, publicVibe: true });
        expect((await request(app).get("/api/public/vibe/library")).status).not.toBe(404);
    });
});
