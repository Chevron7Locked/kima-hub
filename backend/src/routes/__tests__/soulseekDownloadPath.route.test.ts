/**
 * A manual Soulseek download is saved under the music folder as artist/album/file, with names the listener and the
 * peer chose made safe: never outside the music folder, and real names (an ellipsis, a leading dot) kept as they are.
 * Real database, router and tokens; the Soulseek client and settings are stood in for.
 */
const mockDownloadTrack = jest.fn();
jest.mock("../../services/soulseek", () => ({
    soulseekService: { isAvailable: jest.fn().mockResolvedValue(true), downloadTrack: (...a: unknown[]) => mockDownloadTrack(...a) },
}));
jest.mock("../../utils/systemSettings", () => ({ getSystemSettings: jest.fn().mockResolvedValue({ musicPath: "/srv/music" }) }));
jest.mock("../../workers/scanRequest", () => ({ requestScan: jest.fn().mockResolvedValue({ queued: true }) }));

import express from "express";
import request from "supertest";
import path from "path";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import soulseekRoutes from "../soulseek";

const ADMIN = "zz-slsk-dlpath-admin";
const app = express().use(express.json()).use("/soulseek", soulseekRoutes);
const asAdmin = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;

beforeAll(async () => {
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

beforeEach(() => mockDownloadTrack.mockReset().mockResolvedValue({ success: false, error: "stand-in" }));

afterAll(async () => {
    await prisma.downloadJob.deleteMany({ where: { userId: ADMIN } });
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.$disconnect();
});

const download = (body: Record<string, string>) =>
    request(app).post("/soulseek/download").set("Authorization", asAdmin).send({ username: "peer", ...body });
const savedTo = () => mockDownloadTrack.mock.calls[0][1] as string;

it("saves as artist/album/file under the music folder, keeping real names", async () => {
    await download({ filepath: "share\\Trail of Dead\\Source Tags\\01 - Days.flac", artist: "...And You Will Know Us", album: ".hack", filename: "01 - Days.flac" });
    expect(savedTo()).toBe(path.join("/srv/music", "...And You Will Know Us", ".hack", "01 - Days.flac"));
});

it.each([
    [{ artist: "..", album: "..", filename: "x.flac" }],
    [{ artist: "../..", album: "etc", filename: "passwd" }],
    [{ artist: "a", album: "b", filename: ".." }],
])("never saves outside the music folder (%p)", async (names) => {
    await download({ filepath: "x", ...names });
    expect(savedTo().startsWith(path.resolve("/srv/music") + path.sep)).toBe(true);
});

it("takes the file name from the peer's path when none is given", async () => {
    await download({ filepath: "share\\Low\\Things\\03 Sunflower.flac", artist: "Low", album: "Things" });
    expect(savedTo()).toBe(path.join("/srv/music", "Low", "Things", "03 Sunflower.flac"));
    expect(mockDownloadTrack.mock.calls[0][0]).toMatchObject({ username: "peer", filename: "03 Sunflower.flac" });
});

it("names the file track.mp3 when the peer's path ends in a slash and no name is given", async () => {
    await download({ filepath: "share/Low/Things/", artist: "Low", album: "Things" });
    expect(savedTo()).toBe(path.join("/srv/music", "Low", "Things", "track.mp3"));
});
