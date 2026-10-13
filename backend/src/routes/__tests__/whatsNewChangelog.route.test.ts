// The permanent changelog and the quiet open ledger, on the real database.
// The point: dismissing records READ, never DONE — an owed action stays open
// until the server can verify it happened, and closes itself when it can.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import whatsNewRoutes from "../whatsNew";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

// The GPU choice is only shown where CUDA can exist; this ledger test needs the
// host to look GPU-capable so the choice is asked and its dismissal recorded.
jest.mock("../../services/gpuRuntime", () => ({ gpuSupported: () => true, setGpuToggles: jest.fn() }));

const P = "zz-changelog";
const USER = `${P}-user`;
const ADMIN = `${P}-admin`;
const OLD_DATE = new Date("2026-01-01T00:00:00Z");

function app() {
    const a = express();
    a.use(express.json());
    a.use("/whats-new", whatsNewRoutes);
    return a;
}

const as = (id: string, role: "user" | "admin") => `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

async function changelog(role: "user" | "admin" = "admin") {
    const res = await request(app()).get("/whats-new/changelog").set("Authorization", as(role === "admin" ? ADMIN : USER, role));
    expect(res.status).toBe(200);
    return res.body as { releases: Array<{ version: string; dismissed: boolean; items: Array<{ key: string; open?: boolean; done?: boolean; answer?: { enabled: boolean; decidedBy: string } }> }>; openCount: number };
}

const releaseOf = (body: Awaited<ReturnType<typeof changelog>>, version: string) => body.releases.find((r) => r.version === version)!;

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    const artist = await prisma.artist.create({ data: { id: `${P}-art`, name: "Changelog Artist", identityKey: P } });
    await prisma.album.create({
        data: { id: `${P}-alb`, rgMbid: `${P}-rg`, artistId: artist.id, title: "Changelog Album", primaryType: "Album", location: "LIBRARY" },
    });
    await prisma.track.create({
        data: {
            id: `${P}-trk`, albumId: `${P}-alb`, title: "Changelog Song", trackNo: 1, duration: 200,
            filePath: `/tmp/${P}.flac`, fileModified: OLD_DATE, fileSize: 1000, analyzedAt: OLD_DATE,
        },
    });
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await closeEngineConnections();
});

it("lists every release newest first, and hides admin-only items from members", async () => {
    const admin = await changelog("admin");
    const versions = admin.releases.map((r) => r.version);
    expect(new Set(versions)).toEqual(new Set(["1.10.1", "1.11.0", "1.12.0"]));
    expect(versions).toEqual([...versions].sort((a, b) => (a < b ? 1 : -1)));
    expect(releaseOf(admin, "1.11.0").items.some((i) => i.key === "engine.wipe")).toBe(true);

    const member = await changelog("user");
    expect(member.releases.length).toBe(admin.releases.length);
    expect(releaseOf(member, "1.11.0").items.some((i) => i.key === "engine.wipe")).toBe(false);
    expect(member.openCount).toBe(0);
});

it("keeps a dismissed requirement open until the library verifiably passes through, then closes itself", async () => {
    expect((await request(app()).post("/whats-new/1.11.0/dismiss").set("Authorization", as(ADMIN, "admin")).send({})).status).toBe(200);

    const open = await changelog("admin");
    const wipe = releaseOf(open, "1.11.0").items.find((i) => i.key === "engine.wipe")!;
    expect(releaseOf(open, "1.11.0").dismissed).toBe(true);
    expect(wipe.open).toBe(true);
    expect(wipe.done).toBe(false);

    const ledger = await request(app()).get("/whats-new/open").set("Authorization", as(ADMIN, "admin"));
    expect(ledger.status).toBe(200);
    expect(ledger.body.items).toEqual([expect.objectContaining({ version: "1.11.0", key: "engine.wipe" })]);

    // The rerun stamps the track with today's date; the ledger then closes with no further ceremony.
    await prisma.track.update({ where: { id: `${P}-trk` }, data: { analyzedAt: new Date() } });
    const closed = await changelog("admin");
    const wipeAfter = releaseOf(closed, "1.11.0").items.find((i) => i.key === "engine.wipe");
    expect(wipeAfter === undefined || wipeAfter.open === false).toBe(true);
    expect(closed.openCount).toBe(0);
});

it("shows a recorded choice honestly: a dismissal is silence at the default, never consent", async () => {
    const gpu = releaseOf(await changelog("admin"), "1.11.0").items.find((i) => i.key === "gpu.accelerate")!;
    expect(gpu.answer).toEqual({ enabled: false, decidedBy: "DISMISSED" });
});

it("needs a signed-in user", async () => {
    expect((await request(app()).get("/whats-new/changelog")).status).toBe(401);
    expect((await request(app()).get("/whats-new/open")).status).toBe(401);
});
