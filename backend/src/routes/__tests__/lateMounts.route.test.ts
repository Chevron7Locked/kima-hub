// The server as index.ts assembles it, in the parts that were out of order: the queue dashboard (mounted once the
// workers have started) sits in front of the error handler, and the playback state reads its large body only after
// the access check. Real database, real tokens.

import http from "http";
import type { AddressInfo } from "net";
import express, { Router } from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { errorHandler } from "../../middleware/errorHandler";
import { jsonBodyParser } from "../../middleware/jsonBody";
import { UserFacingError } from "../../utils/errors";
import { mountApi, mountQueueBoardSlot, QUEUE_BOARD_PATH } from "../mounts";

const P = "zz-late-mounts";
const MEMBER = `${P}-member`;
const ADMIN = `${P}-admin`;
const as = (id: string, role: "user" | "admin") =>
    `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

const health = (_req: express.Request, res: express.Response) => void res.json({ status: "ok" });

beforeAll(async () => {
    await prisma.user.create({ data: { id: MEMBER, username: MEMBER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

afterAll(async () => {
    await prisma.playbackState.deleteMany({ where: { userId: { in: [MEMBER, ADMIN] } } });
    await prisma.user.deleteMany({ where: { id: { in: [MEMBER, ADMIN] } } });
    await closeEngineConnections();
});

describe("the queue dashboard", () => {
    // index.ts: the routes, the slot for the dashboard, the error handler last, and the dashboard once the workers are up.
    const serverWithDashboard = (board: Router) => {
        const app = express();
        mountApi(app, { health, publicVibe: false });
        const setBoard = mountQueueBoardSlot(app);
        app.use(errorHandler);
        setBoard(board);
        return app;
    };

    it("an error thrown inside it reaches Kima's error handler", async () => {
        const board = Router().get("/boom", () => {
            throw new UserFacingError("the dashboard said no", 418, "teapot");
        });
        const res = await request(serverWithDashboard(board))
            .get(`${QUEUE_BOARD_PATH}/boom`)
            .set("Authorization", as(ADMIN, "admin"));

        expect(res.status).toBe(418);
        expect(res.body).toEqual({ error: "the dashboard said no", code: "teapot" });
    });

    it("is for admins, and before the dashboard is up an admin finds nothing there", async () => {
        const app = express();
        const setBoard = mountQueueBoardSlot(app);
        app.use(errorHandler);
        const path = `${QUEUE_BOARD_PATH}/ping`;

        expect((await request(app).get(path)).status).toBe(401);
        expect((await request(app).get(path).set("Authorization", as(ADMIN, "admin"))).status).toBe(404);

        setBoard(Router().get("/ping", (_req, res) => void res.json({ pong: true })));
        expect((await request(app).get(path).set("Authorization", as(MEMBER, "user"))).status).toBe(403);
        expect((await request(app).get(path).set("Authorization", as(ADMIN, "admin"))).body).toEqual({ pong: true });
    });
});

describe("the playback state's large body", () => {
    const app = express();
    app.use(jsonBodyParser);
    mountApi(app, { health, publicVibe: false });
    app.use(errorHandler);

    const threeMegabytes = "x".repeat(3 * 1024 * 1024);

    /**
     * The status of a POST whose body the server may not read. A server that answers without reading a large body
     * can reset the connection after its answer, which supertest reports as an error instead of the status.
     */
    const postStatus = (path: string, body: string, headers: http.OutgoingHttpHeaders = {}): Promise<number> =>
        new Promise((resolve, reject) => {
            const server = http.createServer(app).listen(0, () => {
                const { port } = server.address() as AddressInfo;
                let answered = false;
                const done = (outcome: () => void) => {
                    server.close(() => outcome());
                    server.closeAllConnections();
                };
                const clientRequest = http.request(
                    { port, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } },
                    (res) => {
                        answered = true;
                        res.resume();
                        done(() => resolve(res.statusCode ?? 0));
                    },
                );
                clientRequest.on("error", (error) => {
                    if (!answered) done(() => reject(error));
                });
                clientRequest.end(body);
            });
        });

    it("is not read for a stranger: a body that would not parse is refused 401, not 400", async () => {
        const broken = await request(app)
            .post("/api/playback-state")
            .set("Content-Type", "application/json")
            .send("{not json");
        expect(broken.status).toBe(401);

        expect(await postStatus("/api/playback-state", `{"playbackType":"track","junk":"${threeMegabytes}`)).toBe(401);
        expect(await postStatus("/api/playback-state", JSON.stringify({ playbackType: "track", junk: threeMegabytes }))).toBe(401);
    });

    it("still saves for a signed-in person", async () => {
        const res = await request(app)
            .post("/api/playback-state")
            .set("Authorization", as(MEMBER, "user"))
            .send({ playbackType: "track", queue: [{ id: "t1", title: "one" }], junk: threeMegabytes });

        expect(res.status).toBe(200);
        const saved = await prisma.playbackState.findUnique({ where: { userId: MEMBER } });
        expect(saved?.playbackType).toBe("track");
    });

    it("refuses more than 5 MB, and gives every other route 1 MB", async () => {
        const signedIn = { Authorization: as(MEMBER, "user") };
        const body = (bytes: number) => JSON.stringify({ playbackType: "track", junk: "x".repeat(bytes) });

        expect(await postStatus("/api/playback-state", body(6 * 1024 * 1024), signedIn)).toBe(413);
        expect(await postStatus("/api/plays", body(3 * 1024 * 1024), signedIn)).toBe(413);
    });
});
