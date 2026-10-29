/**
 * Caching an episode, downloaded from a real local host (under a public name, through the real address check) into
 * a temporary cache folder, with the real database.
 * A feed's declared enclosure length is not the size of the file a host sends (Acast declares 106,668,461 bytes
 * for an episode it sends as 70.6 or 82.7 MB), so only the host's own Content-Length can judge a download.
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { downloadInBackground, getCachedFilePath, isDownloading } from "../podcastDownload";
import { publicUrl, routePublicHost } from "../../__tests__/helpers/publicHost";

const P = "pod_dl_size";
const USER = "u_pod_dl_size";
const DECLARED = 106_668_461;
const BODY = Buffer.from(Array.from({ length: 6000 }, (_, i) => i & 0xff));
let host: http.Server;
let base = "";
let cacheRoot = "";
let originalCache = "";

beforeAll(async () => {
    host = http.createServer((req, res) => {
        if (req.url === "/no-length.mp3") {
            // Chunked: the host states no size at all.
            res.writeHead(200, { "Content-Type": "audio/mpeg" });
            res.write(BODY.subarray(0, 2000));
            res.end(BODY.subarray(2000));
        } else if (req.url === "/cut.mp3") {
            // States 6000 bytes, sends 3000, then drops the connection.
            res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": BODY.length });
            res.write(BODY.subarray(0, 3000), () => res.socket?.destroy());
        } else {
            res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": BODY.length });
            res.end(BODY);
        }
    });
    await new Promise<void>((ok) => host.listen(0, "127.0.0.1", () => ok()));
    routePublicHost();
    base = publicUrl((host.address() as AddressInfo).port);
    cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kima-pod-dl-"));
    originalCache = config.music.transcodeCachePath;
    config.music.transcodeCachePath = path.join(cacheRoot, "transcodes");
    await prisma.user.upsert({ where: { id: USER }, create: { id: USER, username: USER, passwordHash: "x" }, update: {} });
});

beforeEach(async () => {
    await prisma.podcast.deleteMany({ where: { id: P } });
    await prisma.podcast.create({
        data: {
            id: P,
            feedUrl: "https://feeds.example.invalid/dl-size",
            title: "Size Show",
            episodes: {
                create: ["no-length", "cut", "full"].map((name) => ({
                    id: `${P}-${name}`, guid: name, title: name, audioUrl: `${base}/${name}.mp3`,
                    duration: 100, fileSize: DECLARED, publishedAt: new Date(),
                })),
            },
        },
    });
});

afterAll(async () => {
    jest.restoreAllMocks();
    config.music.transcodeCachePath = originalCache;
    await prisma.podcast.deleteMany({ where: { id: P } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await new Promise<void>((ok) => host.close(() => ok()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
});

/** Download in the background as playback does, and wait until it has finished, retries included. */
async function download(name: string) {
    const id = `${P}-${name}`;
    downloadInBackground(id, `${base}/${name}.mp3`, USER);
    while (isDownloading(id)) await new Promise((ok) => setTimeout(ok, 50));
    const cached = await getCachedFilePath(id);
    const episode = await prisma.podcastEpisode.findUniqueOrThrow({ where: { id }, select: { fileSize: true } });
    return { cached, bytes: cached ? (await fs.promises.stat(cached)).size : 0, storedSize: episode.fileSize };
}

it("caches a file whose host states no size, and stores the size of the file it holds", async () => {
    const got = await download("no-length");
    expect(got.cached).not.toBeNull();
    expect(got.bytes).toBe(BODY.length);
    expect(got.storedSize).toBe(BODY.length);
}, 30_000);

it("caches a file sized by the host's Content-Length, not by the feed's declared length", async () => {
    const got = await download("full");
    expect(got.cached).not.toBeNull();
    expect(got.storedSize).toBe(BODY.length);
}, 30_000);

it("keeps nothing from a download that ends short of the host's Content-Length", async () => {
    const got = await download("cut");
    expect(got.cached).toBeNull();
    expect(fs.existsSync(path.join(cacheRoot, "podcast-audio", `${P}-cut.tmp`))).toBe(false);
}, 30_000);

it("keeps a complete cached file whatever the feed now declares, and drops one its record does not match", async () => {
    const id = `${P}-full`;
    expect((await download("full")).cached).not.toBeNull();

    // A size from somewhere other than the download (the feed's enclosure length) does not judge the cache.
    await prisma.podcastEpisode.update({ where: { id }, data: { fileSize: DECLARED } });
    expect(await getCachedFilePath(id)).not.toBeNull();

    // A file that no longer matches what was recorded is incomplete: it and its record go.
    await fs.promises.appendFile(path.join(cacheRoot, "podcast-audio", `${id}.mp3`), Buffer.alloc(500));
    expect(await getCachedFilePath(id)).toBeNull();
    expect(await prisma.podcastDownload.count({ where: { episodeId: id } })).toBe(0);
}, 30_000);
