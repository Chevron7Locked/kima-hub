/**
 * The image backfill puts a downloaded picture in place only after the row still holds the address it read: a picture
 * a person stored under the same name while it downloaded is never overwritten. Real database and files; the host's
 * reply is replaced.
 */

import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const COVERS_ROOT = `/tmp/kima-test-backfill-${process.pid}`;

jest.mock("../../config", () => ({
    ...jest.requireActual("../../config"),
    config: {
        ...jest.requireActual("../../config").config,
        music: { ...jest.requireActual("../../config").config.music, transcodeCachePath: `/tmp/kima-test-backfill-${process.pid}/transcode` },
    },
}));
jest.mock("../../utils/ssrf", () => ({ fetchChecked: jest.fn() }));

import { prisma } from "../../utils/db";
import { fetchChecked } from "../../utils/ssrf";
import { backfillAllImages, getImageBackfillProgress } from "../imageBackfill";
import { versionOfFile } from "../imageStorage";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(30_000);

const P = "zz-imgpub";
const fetchMock = fetchChecked as jest.Mock;
const albums = path.join(COVERS_ROOT, "covers", "albums");
const artists = path.join(COVERS_ROOT, "covers", "artists");

async function jpeg(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    return sharp(randomBytes(100 * 100 * 3), { raw: { width: 100, height: 100, channels: 3 } }).jpeg().toBuffer();
}

function reply(body: Buffer): Response {
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg" } });
}

/** Answers the one address under test; a row another test left behind finds nothing. */
function serve(answer: () => Promise<Response>) {
    fetchMock.mockImplementation(async (url: string) => (url === "http://example.invalid/c.jpg" ? answer() : new Response(null, { status: 404 })));
}

async function clean() {
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

async function seedAlbum() {
    const artistId = `${P}-ar`;
    await prisma.artist.create({ data: { id: artistId, name: artistId, normalizedName: artistId, identityKey: artistId } });
    await prisma.album.create({
        data: { id: `${P}-al`, artistId, title: "t", identityKey: `${P}-al`, rgMbid: `${P}-al`, primaryType: "Album", coverUrl: "http://example.invalid/c.jpg" },
    });
}

beforeEach(async () => {
    await clean();
    fs.rmSync(COVERS_ROOT, { recursive: true, force: true });
    fs.mkdirSync(albums, { recursive: true });
    fs.mkdirSync(artists, { recursive: true });
});

afterEach(() => {
    jest.restoreAllMocks();
    fetchMock.mockReset();
});

afterAll(async () => {
    await clean();
    fs.rmSync(COVERS_ROOT, { recursive: true, force: true });
    await closeEngineConnections();
});

describe("backfillAllImages and the picture a person stored while it downloaded", () => {
    it("stores the picture under the final name when the row still holds the address it read", async () => {
        await seedAlbum();
        const downloaded = await jpeg();
        serve(async () => reply(downloaded));

        await backfillAllImages();

        expect(fs.readFileSync(path.join(albums, `${P}-al.jpg`)).equals(downloaded)).toBe(true);
        const stored = (await prisma.album.findUniqueOrThrow({ where: { id: `${P}-al` } })).coverUrl;
        expect(stored).toBe(`native:albums/${P}-al.jpg?v=${await versionOfFile(path.join(albums, `${P}-al.jpg`))}`);
        expect(getImageBackfillProgress()).toMatchObject({ success: 1, skipped: 0, failed: 0 });
        expect(fs.readdirSync(albums)).toEqual([`${P}-al.jpg`]);
    });

    it("leaves the person's picture whole, and no leftover file, when they stored one under the same name meanwhile", async () => {
        await seedAlbum();
        const theirs = await jpeg();
        const mine = path.join(albums, `${P}-al.jpg`);
        serve(async () => {
            fs.writeFileSync(mine, theirs);
            await prisma.album.update({
                where: { id: `${P}-al` },
                data: { coverUrl: `native:albums/${P}-al.jpg?v=${await versionOfFile(mine)}` },
            });
            return reply(await jpeg());
        });

        await backfillAllImages();

        expect(fs.readFileSync(mine).equals(theirs)).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}-al` } })).coverUrl).toMatch(/^native:albums\/.*\?v=/);
        expect(getImageBackfillProgress()).toMatchObject({ success: 0, skipped: 1, failed: 0 });
        expect(fs.readdirSync(albums)).toEqual([`${P}-al.jpg`]);
    });

    it("keeps the external address, and counts the row failed, when the picture cannot be put in place", async () => {
        await seedAlbum();
        serve(async () => reply(await jpeg()));
        jest.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("swap failed"));

        await backfillAllImages();

        expect((await prisma.album.findUniqueOrThrow({ where: { id: `${P}-al` } })).coverUrl).toBe("http://example.invalid/c.jpg");
        expect(getImageBackfillProgress()).toMatchObject({ success: 0, failed: 1 });
        expect(fs.readdirSync(albums)).toEqual([]);
    });
});
