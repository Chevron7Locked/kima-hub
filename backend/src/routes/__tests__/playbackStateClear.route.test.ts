/**
 * DELETE /api/playback-state: a clear that names the time it saw (`expectedUpdatedAt`) clears only while that is
 * still the stored time, under the lock every save takes. Real database.
 */

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-user"] };
        next();
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import playbackStateRouter from "../playbackState";
import { mountAsServer } from "./helpers/serverMount";
import { untilLockWait } from "../../__tests__/helpers/lockWait";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

const PREFIX = "playback-state-clear-test";
const S = "pbclear";

const app = express();
app.use(express.json());
mountAsServer(app, "/api/playback-state", playbackStateRouter, "/api/playback-state");

async function cleanup() {
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: S } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: S } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: S } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${S}art`, name: "Clear Artist", identityKey: `${S}-a` } });
    await prisma.album.create({ data: { id: `${S}alb`, artistId: `${S}art`, rgMbid: `${S}-rg`, identityKey: `${S}-ak`, title: "Clear Album", primaryType: "Album" } });
    for (const id of ["s1", "s3"]) {
        await prisma.track.create({
            data: {
                id: `${S}${id}`, albumId: `${S}alb`, title: id, trackNo: 1, duration: 100, filePath: `/tmp/${S}${id}.flac`,
                fileModified: new Date(), fileSize: 1,
            },
        });
    }
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

const save = (userId: string, body: object) => request(app).post("/api/playback-state").set("x-user", userId).send(body);
const clear = (userId: string, expectedUpdatedAt?: string) =>
    request(app).delete("/api/playback-state").set("x-user", userId).query(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt });
const newUser = (name: string) => prisma.user.create({ data: { username: `${PREFIX}-${name}`, passwordHash: "x", role: "user" } });
const stored = (userId: string) => prisma.playbackState.findUnique({ where: { userId } });
const song = (n: string) => ({ id: `${S}${n}`, title: n, duration: 100 });

describe("DELETE /api/playback-state with expectedUpdatedAt", () => {
    it("clears when the stored state is still the one seen", async () => {
        const user = await newUser("ok");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();

        const res = await clear(user.id, seen);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, cleared: 1 });
        expect(await stored(user.id)).toBeNull();
    });

    it("refuses with 409 and the newer state, as a read shows it, when another save came in since, and clears nothing", async () => {
        const user = await newUser("newer");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();
        await save(user.id, { playbackType: "track", trackId: `${S}s3`, queue: [song("s3")], currentIndex: 0 }).expect(200);

        const res = await clear(user.id, seen);

        expect(res.status).toBe(409);
        expect(typeof res.body.error).toBe("string");
        const read = await request(app).get("/api/playback-state").set("x-user", user.id).expect(200);
        expect(res.body.state).toEqual(read.body);
        expect(res.body.state.trackId).toBe(`${S}s3`);
        expect((await stored(user.id))!.trackId).toBe(`${S}s3`);
    });

    it("answers success for a state that is already gone, as a plain clear does", async () => {
        const user = await newUser("gone");
        const res = await clear(user.id, new Date().toISOString());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, cleared: 0 });
    });

    it("checks the time inside the lock saves take: a save landing while it waits makes it 409 and the state stays", async () => {
        const user = await newUser("locked");
        await save(user.id, { playbackType: "track", trackId: `${S}s1`, queue: [song("s1")], currentIndex: 0 }).expect(200);
        const seen = (await stored(user.id))!.updatedAt.toISOString();

        let waiting!: Promise<request.Response>;
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "userId" FROM "PlaybackState" WHERE "userId" = ${user.id} FOR UPDATE`;
            waiting = clear(user.id, seen).then((r) => r);
            await untilLockWait(`"PlaybackState"`);
            await tx.playbackState.update({ where: { userId: user.id }, data: { trackId: `${S}s3` } });
        });

        expect((await waiting).status).toBe(409);
        expect((await stored(user.id))!.trackId).toBe(`${S}s3`);
    });

    it("answers 400 for a time that is not a date, and clears nothing", async () => {
        expectLog("warn");
        const user = await newUser("bad");
        await save(user.id, { playbackType: "track", trackId: `${S}s1` }).expect(200);
        const res = await clear(user.id, "yesterday");
        expect(res.status).toBe(400);
        expect(await stored(user.id)).not.toBeNull();
    });

    it("answers 400 for a time named twice or left empty, rather than clearing without the check", async () => {
        expectLog("warn");
        const user = await newUser("shape");
        await save(user.id, { playbackType: "track", trackId: `${S}s1` }).expect(200);
        const twice = await request(app).delete("/api/playback-state?expectedUpdatedAt=a&expectedUpdatedAt=b").set("x-user", user.id);
        const empty = await request(app).delete("/api/playback-state?expectedUpdatedAt=").set("x-user", user.id);
        expect(twice.status).toBe(400);
        expect(empty.status).toBe(400);
        expect(await stored(user.id)).not.toBeNull();
    });

    it("leaves a clear that names no time as it was: it clears whatever is stored", async () => {
        const user = await newUser("none");
        await save(user.id, { playbackType: "track", trackId: `${S}s1` }).expect(200);
        const res = await clear(user.id);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, cleared: 1 });
        expect(await stored(user.id)).toBeNull();
    });
});
