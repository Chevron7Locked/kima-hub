/**
 * An audiobook's cover version is the content hash of the picture, taken when the sync stores the cover: a sync that
 * stores the same picture again leaves the version (and so the address clients keep) as it was, a changed picture is a new
 * version, and a sync whose download fails leaves the stored version alone. Real database and files; Audiobookshelf's
 * listing and its cover download are stood in for.
 */
const MUSIC = require("path").join(require("os").tmpdir(), `kima-abs-version-${process.pid}`);

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../config", () => ({
    ...jest.requireActual("../../config"),
    config: { music: { musicPath: require("path").join(require("os").tmpdir(), `kima-abs-version-${process.pid}`) } },
}));
jest.mock("../audiobookshelf", () => ({
    audiobookshelfService: { getAllAudiobooks: jest.fn() },
}));
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn().mockResolvedValue({ audiobookshelfUrl: "http://abs.test:13378", audiobookshelfApiKey: "abs-key" }),
}));

import fs from "fs";
import path from "path";
import { audiobookCacheService } from "../audiobookCache";
import { audiobookshelfService } from "../audiobookshelf";
import { versionOfFile } from "../imageStorage";
import { prisma } from "../../utils/db";

const ID = "zz-abs-coverversion-book";
const FILE = path.join(MUSIC, "cover-cache", "audiobooks", `${ID}.jpg`);

async function jpeg(color: string): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).jpeg().toBuffer();
}

const book = { id: ID, libraryId: "lib1", media: { coverPath: "/audiobooks/x/cover.jpg", metadata: { title: "Cover Version Book", authorName: "A" } } };

async function syncWithCover(reply: () => Response) {
    (audiobookshelfService.getAllAudiobooks as jest.Mock).mockResolvedValue({ books: [book], complete: true });
    jest.spyOn(global, "fetch").mockImplementation(async () => reply());
    await audiobookCacheService.syncAll();
}
const stored = () => prisma.audiobook.findUniqueOrThrow({ where: { id: ID } });
const picture = (bytes: Buffer) => () => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/jpeg" } });

beforeEach(async () => {
    await prisma.audiobook.deleteMany({});
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
    await prisma.audiobook.deleteMany({});
    fs.rmSync(MUSIC, { recursive: true, force: true });
});

describe("a synced audiobook's cover version", () => {
    it("is the hash of the picture stored, whatever the time of the sync", async () => {
        await syncWithCover(picture(await jpeg("#336699")));

        const row = await stored();
        expect(row.coverVersion).toBe(await versionOfFile(FILE));
        expect(row.coverVersion).toMatch(/^[0-9a-f]{10}$/);
    });

    it("stays the same when the next sync stores the same picture, though the book was synced later", async () => {
        const bytes = await jpeg("#336699");
        await syncWithCover(picture(bytes));
        const first = await stored();

        await new Promise((r) => setTimeout(r, 15));
        await syncWithCover(picture(bytes));
        const second = await stored();

        expect(second.lastSyncedAt.getTime()).toBeGreaterThan(first.lastSyncedAt.getTime());
        expect(second.coverVersion).toBe(first.coverVersion);
    });

    it("is a new one when the picture changed", async () => {
        await syncWithCover(picture(await jpeg("#336699")));
        const before = (await stored()).coverVersion;

        await syncWithCover(picture(await jpeg("#cc3300")));

        const after = await stored();
        expect(after.coverVersion).not.toBe(before);
        expect(after.coverVersion).toBe(await versionOfFile(FILE));
    });

    it("is left as it was when the sync could not download the cover", async () => {
        await syncWithCover(picture(await jpeg("#336699")));
        const before = await stored();

        await syncWithCover(() => new Response("gone", { status: 500 }));

        const after = await stored();
        expect(after.coverVersion).toBe(before.coverVersion);
        expect(after.localCoverPath).toBe(before.localCoverPath);
    });
});
