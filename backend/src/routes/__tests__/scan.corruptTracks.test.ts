/**
 * DELETE /library/corrupt-tracks clears the corrupt flag and keeps the rows.
 */

const mockScanAdd = jest.fn().mockResolvedValue({ id: "scan-1" });
const mockScanGetJob = jest.fn().mockResolvedValue(null);

jest.mock("../../workers/queues", () => ({
    scanQueue: { add: mockScanAdd, getJob: mockScanGetJob },
}));
jest.mock("../../workers/organizeSingles", () => ({ organizeSingles: jest.fn() }));
// `../../utils/db` and `../../middleware/auth` stay real: the point is
// that the ROW survives the handler and that requireAdmin is enforced.

import request from "supertest";
import express from "express";

import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import scanRouter from "../../routes/library/scan";
import { mountAsServer } from "./helpers/serverMount";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";

const PREFIX = "corrupt";
const id = (n: string) => `${PREFIX}_${n}`;

async function seedLibrary(): Promise<void> {
    await prisma.artist.create({
        data: { id: id("art"), name: "Corrupt Artist", identityKey: id("a") },
    });
    await prisma.album.create({
        data: { id: id("alb"), rgMbid: id("rg"), artistId: id("art"), title: "Corrupt Album", primaryType: "Album" },
    });
    await prisma.track.create({
        data: {
            id: id("t1"),
            albumId: id("alb"),
            title: "Broken file",
            trackNo: 1,
            duration: 180,
            filePath: `/tmp/${id("t1")}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            corrupt: true,
        } as never,
    });
}

async function wipe(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "TrackStage" WHERE "trackId" LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, `${PREFIX}_%`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, id("alb"));
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, id("art"));
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE $1`, `${PREFIX}_%`);
}

let app: express.Express;

async function makeUser(userId: string, role: "admin" | "user"): Promise<string> {
    await prisma.user.create({
        data: { id: userId, username: userId, passwordHash: "x", role, tokenVersion: 0 },
    });
    return generateToken({ id: userId, username: userId, role, tokenVersion: 0 });
}

beforeEach(async () => {
    jest.clearAllMocks();
    await wipe();
    await seedLibrary();
    app = express();
    app.use(express.json());
    mountAsServer(app, "/library", scanRouter, "/api/library");
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

describe("DELETE /library/corrupt-tracks", () => {
    it("clears the corrupt flag and keeps the Track row", async () => {
        const token = await makeUser(id("boss"), "admin");

        const res = await request(app)
            .delete("/library/corrupt-tracks")
            .set("Authorization", `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.cleared).toBe(1);
        // The response must not claim a deletion.
        expect(res.body.deleted).toBeUndefined();

        // The file still exists and still needs an answer: deleting the row
        // would only make the scanner re-create it and re-ask from scratch.
        const stillThere = await prisma.track.findUnique({ where: { id: id("t1") } });
        expect(stillThere).not.toBeNull();
        expect(stillThere?.title).toBe("Broken file");
        // The flag itself is cleared — "I know, re-check it" — while the
        // row and everything recorded against it survive.
        expect(stillThere?.corrupt).toBe(false);
    });

    it("shows the true state: the corrupt track is listed before the clear and not after", async () => {
        const token = await makeUser(id("boss2"), "admin");

        const before = await request(app)
            .get("/library/corrupt-tracks")
            .set("Authorization", `Bearer ${token}`);
        expect(before.status).toBe(200);
        expect(before.body.count).toBe(1);
        expect(before.body.tracks[0]).toMatchObject({ id: id("t1"), title: "Broken file" });

        const clear = await request(app)
            .delete("/library/corrupt-tracks")
            .set("Authorization", `Bearer ${token}`);
        expect(clear.status).toBe(200);

        const after = await request(app)
            .get("/library/corrupt-tracks")
            .set("Authorization", `Bearer ${token}`);
        expect(after.body.count).toBe(0);

        // And the row is still there — the list is honest in both states.
        expect(await prisma.track.findUnique({ where: { id: id("t1") } })).not.toBeNull();
    });

    it("is admin-only: 403 for a signed-in non-admin, 401 with no credential", async () => {
        const plain = await makeUser(id("plain"), "user");

        const forbidden = await request(app)
            .delete("/library/corrupt-tracks")
            .set("Authorization", `Bearer ${plain}`);
        expect(forbidden.status).toBe(403);
        expect(forbidden.body.error).toBe("Admin access required");

        const anonymous = await request(app).delete("/library/corrupt-tracks");
        expect(anonymous.status).toBe(401);

        // The non-admin call changed nothing — the flag is still set.
        const track = await prisma.track.findUnique({ where: { id: id("t1") } });
        expect(track?.corrupt).toBe(true);
    });
});

describe("the library-changed marker on DELETE /library/corrupt-tracks", () => {
    const clear = (token: string) => request(app).delete("/library/corrupt-tracks").set("Authorization", `Bearer ${token}`);

    it("moves when a song on a library album is cleared, because the library lists it again", async () => {
        const token = await makeUser(id("boss3"), "admin");
        expect(await markerMoves(() => clear(token))).toBe(true);
    });

    it("leaves it when the cleared song is on a Discover album", async () => {
        const token = await makeUser(id("boss4"), "admin");
        await prisma.album.update({ where: { id: id("alb") }, data: { location: "DISCOVER" } });
        expect(await markerMoves(() => clear(token))).toBe(false);
    });

    it("leaves it when the cleared song is also missing, because the library still does not list it", async () => {
        const token = await makeUser(id("boss6"), "admin");
        await prisma.track.update({ where: { id: id("t1") }, data: { missingSince: new Date() } });
        expect(await markerMoves(() => clear(token))).toBe(false);
        expect((await prisma.track.findUniqueOrThrow({ where: { id: id("t1") } })).corrupt).toBe(false);
    });

    it("leaves it when no song is flagged", async () => {
        const token = await makeUser(id("boss5"), "admin");
        await prisma.track.update({ where: { id: id("t1") }, data: { corrupt: false } });
        expect(await markerMoves(() => clear(token))).toBe(false);
    });
});
