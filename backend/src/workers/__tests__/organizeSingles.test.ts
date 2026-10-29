/**
 * The organizer works in the one music folder (the one scans read), and moves a
 * file by rename or copy → verify → unlink. Real files in a temp dir.
 */

import fs from "fs";
import path from "path";
import os from "os";

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: mockGetSystemSettings,
}));

const mockSessionLog = jest.fn();
jest.mock("../../utils/playlistLogger", () => ({
    sessionLog: mockSessionLog,
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        downloadJob: { findMany: jest.fn().mockResolvedValue([]) },
        downloadSource: { findMany: jest.fn().mockResolvedValue([]) },
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { organizeSingles } from "../organizeSingles";
import { config, useMusicFolder } from "../../config";

const startFolder = config.music.musicPath;
afterAll(() => useMusicFolder(startFolder));

let root: string;

beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "organize-t9-"));
    // One album folder, two files, under the old Soulseek layout.
    const dir = path.join(root, "Soulseek", "Artist X - Album Y (2024)");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "01 one.flac"), Buffer.alloc(1024, 7));
    fs.writeFileSync(path.join(dir, "02 two.flac"), Buffer.alloc(2048, 7));
    useMusicFolder(root);
    mockGetSystemSettings.mockResolvedValue({ musicPath: "/somewhere/else" });
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

it("moves the files into Singles and removes them from Soulseek", async () => {
    await organizeSingles();

    const destDir = path.join(root, "Singles", "Artist X", "Album Y");
    expect(
        fs.readdirSync(destDir).sort(),
    ).toEqual(["01 one.flac", "02 two.flac"]);
    // The source folder is gone (emptied, then cleaned).
    expect(fs.existsSync(path.join(root, "Soulseek"))).toBe(false);
    // Copy preserved bytes, not just names.
    expect(
        fs.readFileSync(path.join(destDir, "01 one.flac")).equals(Buffer.alloc(1024, 7)),
    ).toBe(true);
});

it("runs once: the marker stops a second migration", async () => {
    await organizeSingles();
    fs.mkdirSync(path.join(root, "Soulseek", "Late"), { recursive: true });
    fs.writeFileSync(path.join(root, "Soulseek", "Late", "new.flac"), Buffer.alloc(10));

    await organizeSingles(); // marker exists — nothing moves

    expect(fs.existsSync(path.join(root, "Singles", "Late", "new.flac"))).toBe(false);
});

it("works in the folder scans read, whatever the settings row holds", async () => {
    await organizeSingles();

    expect(fs.existsSync(path.join(root, "Singles", "Artist X", "Album Y", "01 one.flac"))).toBe(true);
    expect(fs.existsSync("/somewhere/else")).toBe(false);
});

it("keeps the sources and skips the marker when the cross-device copy comes up short", async () => {
    // The first four tests share one volume, so only `rename` runs
    // there. This forces the EXDEV branch and a short copy — the
    // assertions below only pass if the copy path verifies the copy
    // before touching the source.
    const fsPromises = require("fs/promises");
    jest
        .spyOn(fsPromises, "rename")
        .mockRejectedValue(Object.assign(new Error("cross-device link"), { code: "EXDEV" }));
    jest.spyOn(fsPromises, "copyFile").mockImplementation(
        async (...args: unknown[]) => {
            const dest = String(args[1]);
            await fsPromises.writeFile(dest, Buffer.alloc(10, 7)); // < 1024/2048
        },
    );

    await organizeSingles();

    const srcDir = path.join(root, "Soulseek", "Artist X - Album Y (2024)");
    expect(fs.readFileSync(path.join(srcDir, "01 one.flac")).length).toBe(1024);
    expect(fs.readFileSync(path.join(srcDir, "02 two.flac")).length).toBe(2048);
    // The short copies were unlinked, not kept, and not trusted.
    expect(
        fs.existsSync(path.join(root, "Singles", "Artist X", "Album Y", "01 one.flac")),
    ).toBe(false);
    // Migration is not marked complete while files remain.
    expect(fs.existsSync(path.join(root, ".soulseek-migrated"))).toBe(false);

    jest.restoreAllMocks();
});