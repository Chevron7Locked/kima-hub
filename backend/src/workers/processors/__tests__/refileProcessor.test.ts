/**
 * The re-file job: runs the re-file, tells the admin who asked how it went, and records that albums were re-filed
 * (which closes the 1.12 release item) only when every album could be re-filed and songs were read at all. Real
 * database; the re-file itself and the notification tray are stood in for.
 */
jest.mock("../../../utils/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const mockRefile = jest.fn();
jest.mock("../../../services/albumRefile", () => ({ refileLibrary: (...a: unknown[]) => mockRefile(...a) }));
const mockNotify = jest.fn();
jest.mock("../../../services/notificationService", () => ({ notificationService: { create: (...a: unknown[]) => mockNotify(...a) } }));

import type { Job } from "bullmq";
import { prisma } from "../../../utils/db";
import { config } from "../../../config";
import { processRefile } from "../refileProcessor";

const clean = { songsRead: 10, songsUnreadable: 0, albumsMoved: 2, albumsMerged: 1, keptEdited: 0, artistsRenamed: 0, albumsFailed: 0, artistsRemoved: 2 };
const job = { id: "refile-albums", data: { userId: "refile-admin" } } as Job<{ userId: string }>;
const stamped = async () => (await prisma.systemSettings.findUnique({ where: { id: "default" }, select: { albumsRefiledAt: true } }))?.albumsRefiledAt ?? null;

beforeEach(async () => {
    mockRefile.mockReset();
    mockNotify.mockReset();
    mockNotify.mockResolvedValue(undefined);
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: { albumsRefiledAt: null } });
});

afterAll(async () => {
    await prisma.systemSettings.update({ where: { id: "default" }, data: { albumsRefiledAt: null } });
    await prisma.$disconnect();
});

it("re-files the music folder, records it, and tells the admin what moved", async () => {
    mockRefile.mockResolvedValue(clean);
    await processRefile(job);
    expect(mockRefile).toHaveBeenCalledWith(config.music.musicPath);
    expect(await stamped()).not.toBeNull();
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ userId: "refile-admin", type: "system", groupKey: "library-refile", renotify: true }));
    expect(mockNotify.mock.calls[0][0].message).toMatch(/2 albums moved/);
});

it("does not record a run with albums it could not re-file, and says so", async () => {
    mockRefile.mockResolvedValue({ ...clean, albumsFailed: 3 });
    await processRefile(job);
    expect(await stamped()).toBeNull();
    expect(mockNotify.mock.calls[0][0].message).toMatch(/3 albums could not be re-filed/);
});

it("does not record a run that could read no songs, and asks whether the drive is there", async () => {
    mockRefile.mockResolvedValue({ ...clean, songsRead: 0, songsUnreadable: 500, albumsMoved: 0, albumsMerged: 0, artistsRemoved: 0 });
    await processRefile(job);
    expect(await stamped()).toBeNull();
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(mockNotify.mock.calls[0][0].message).toMatch(/mounted/);
});

it("tells the admin when the re-file fails, and fails the job", async () => {
    mockRefile.mockRejectedValue(new Error("disk gone"));
    await expect(processRefile(job)).rejects.toThrow("disk gone");
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ type: "error", groupKey: "library-refile" }));
});

it("still records a finished re-file when the notification cannot be sent", async () => {
    mockRefile.mockResolvedValue(clean);
    mockNotify.mockRejectedValue(new Error("tray down"));
    await expect(processRefile(job)).resolves.toEqual(clean);
    expect(await stamped()).not.toBeNull();
});
