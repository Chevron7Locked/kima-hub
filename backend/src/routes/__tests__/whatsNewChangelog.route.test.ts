// The permanent changelog and the quiet open ledger, on the real database. Dismissing records READ, never DONE:
// an owed action stays open until the server can verify it happened, and closes itself when it can. Two fixture
// releases stand in for the catalogue, so the test does not change with each release; their dates fall between the
// test library's analysis date and today, so the library reads as an upgrade until a re-run stamps it.

import type { Release } from "../../services/releases/catalog";

const FIXTURES: Release[] = [
    {
        version: "9.0.0",
        title: "Kima 9",
        summary: "An older fixture release.",
        date: "2026-06-01",
        items: [
            { kind: "action", key: "fixture.wipe", title: "Wipe", summary: "s", body: "b", cta: "Wipe", run: "wipeEnrichment", requires: "admin", olderLibraryOnly: true },
            { kind: "choice", key: "fixture.choice", title: "Choice", summary: "s", body: "b", defaultValue: false, requires: "admin" },
        ],
    },
    {
        version: "9.1.0",
        title: "Kima 9.1",
        summary: "A newer fixture release.",
        date: "2026-07-01",
        items: [
            { kind: "note", key: "fixture.rebuild", title: "Rebuilt", summary: "s", body: "b", olderLibraryOnly: true },
            { kind: "action", key: "fixture.refile", title: "Refile", summary: "s", body: "b", cta: "Re-file", run: "refileAlbums", requires: "admin", installedBeforeOnly: true },
        ],
    },
];
jest.mock("../../services/releases/catalog", () => {
    const actual = jest.requireActual("../../services/releases/catalog");
    return { ...actual, RELEASES: FIXTURES, findRelease: (v: string) => FIXTURES.find((r) => r.version === v) };
});

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import whatsNewRoutes from "../whatsNew";
import { RELEASES } from "../../services/releases/catalog";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

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
    return res.body as { releases: Array<{ version: string; date: string; dismissed: boolean; items: Array<{ key: string; open?: boolean; done?: boolean; answer?: { enabled: boolean; decidedBy: string } }> }>; openCount: number };
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
    expect(new Set(versions)).toEqual(new Set(RELEASES.map((r) => r.version)));
    // Newest first by release date, never by the version's text (which sorts 1.9 after 1.10).
    const dates = admin.releases.map((r) => r.date);
    expect(dates).toEqual([...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    expect(releaseOf(admin, "9.0.0").items.some((i) => i.key === "fixture.wipe")).toBe(true);

    const member = await changelog("user");
    expect(member.releases.length).toBe(admin.releases.length);
    expect(releaseOf(member, "9.0.0").items.some((i) => i.key === "fixture.wipe")).toBe(false);
    expect(member.openCount).toBe(0);
});

it("shows an upgrade-only note to an upgraded library, and only an upgraded one", async () => {
    // This library holds analysis from before the release: an upgrade, so everyone is told, members too.
    expect(releaseOf(await changelog("admin"), "9.1.0").items.some((i) => i.key === "fixture.rebuild")).toBe(true);
    expect(releaseOf(await changelog("user"), "9.1.0").items.some((i) => i.key === "fixture.rebuild")).toBe(true);

    // A library analysed only after the release is a fresh install: there was nothing to rebuild.
    await prisma.track.update({ where: { id: `${P}-trk` }, data: { analyzedAt: new Date() } });
    try {
        expect(releaseOf(await changelog("admin"), "9.1.0").items.some((i) => i.key === "fixture.rebuild")).toBe(false);
    } finally {
        await prisma.track.update({ where: { id: `${P}-trk` }, data: { analyzedAt: OLD_DATE } });
    }
});

it("keeps a dismissed requirement open until the library verifiably passes through, then closes itself", async () => {
    expect((await request(app()).post("/whats-new/9.0.0/dismiss").set("Authorization", as(ADMIN, "admin")).send({})).status).toBe(200);

    const open = await changelog("admin");
    const wipe = releaseOf(open, "9.0.0").items.find((i) => i.key === "fixture.wipe")!;
    expect(releaseOf(open, "9.0.0").dismissed).toBe(true);
    expect(wipe.open).toBe(true);
    expect(wipe.done).toBe(false);

    const libraryAsked = jest.spyOn(prisma, "$queryRaw");
    const askedAboutLibrary = () => libraryAsked.mock.calls.filter((c) => String(c[0]).includes("track_embeddings")).length;
    const ledger = await request(app()).get("/whats-new/open").set("Authorization", as(ADMIN, "admin"));
    expect(ledger.status).toBe(200);
    // One request asks about the library once per release date, however many of that release's items depend on it.
    const upgradeDates = new Set(
        RELEASES.filter((r) => r.items.some((i) => (i.kind === "action" || i.kind === "note") && i.olderLibraryOnly)).map((r) => r.date),
    );
    expect(askedAboutLibrary()).toBe(upgradeDates.size);
    expect(ledger.body.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ version: "9.0.0", key: "fixture.wipe" })]),
    );

    // The rerun stamps the track with today's date; the ledger then closes with no further ceremony.
    await prisma.track.update({ where: { id: `${P}-trk` }, data: { analyzedAt: new Date() } });
    const closed = await changelog("admin");
    const wipeAfter = releaseOf(closed, "9.0.0").items.find((i) => i.key === "fixture.wipe");
    expect(wipeAfter === undefined || wipeAfter.open === false).toBe(true);
    libraryAsked.mockRestore();
});

it("keeps the re-file open for admins until albums have been re-filed, then closes it", async () => {
    await prisma.track.update({ where: { id: `${P}-trk` }, data: { analyzedAt: OLD_DATE } });
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default", createdAt: OLD_DATE }, update: { albumsRefiledAt: null, createdAt: OLD_DATE } });
    // Tracked once the window that offered it is closed.
    expect((await request(app()).post("/whats-new/9.1.0/dismiss").set("Authorization", as(ADMIN, "admin")).send({})).status).toBe(200);
    try {
        const refile = releaseOf(await changelog("admin"), "9.1.0").items.find((i) => i.key === "fixture.refile")!;
        expect(refile.open).toBe(true);
        expect(refile.done).toBe(false);
        expect(releaseOf(await changelog("user"), "9.1.0").items.some((i) => i.key === "fixture.refile")).toBe(false);

        // The upgrade's own re-analysis restamps every song; the re-file is still owed.
        await prisma.track.update({ where: { id: `${P}-trk` }, data: { analyzedAt: new Date() } });
        expect(releaseOf(await changelog("admin"), "9.1.0").items.find((i) => i.key === "fixture.refile")!.open).toBe(true);

        await prisma.systemSettings.update({ where: { id: "default" }, data: { albumsRefiledAt: new Date() } });
        const after = releaseOf(await changelog("admin"), "9.1.0").items.find((i) => i.key === "fixture.refile")!;
        expect(after.open).toBe(false);
        expect(after.done).toBe(true);

        // A server set up after the release never had albums filed the old way: it is not offered.
        await prisma.systemSettings.update({ where: { id: "default" }, data: { createdAt: new Date("2026-08-01T00:00:00Z") } });
        expect(releaseOf(await changelog("admin"), "9.1.0").items.some((i) => i.key === "fixture.refile")).toBe(false);
    } finally {
        await prisma.systemSettings.update({ where: { id: "default" }, data: { albumsRefiledAt: null, createdAt: OLD_DATE } });
        await prisma.track.update({ where: { id: `${P}-trk` }, data: { analyzedAt: OLD_DATE } });
    }
});

it("shows a recorded choice honestly: a dismissal is silence at the default, never consent", async () => {
    const choice = releaseOf(await changelog("admin"), "9.0.0").items.find((i) => i.key === "fixture.choice")!;
    expect(choice.answer).toEqual({ enabled: false, decidedBy: "DISMISSED" });
});

it("needs a signed-in user", async () => {
    expect((await request(app()).get("/whats-new/changelog")).status).toBe(401);
    expect((await request(app()).get("/whats-new/open")).status).toBe(401);
});
