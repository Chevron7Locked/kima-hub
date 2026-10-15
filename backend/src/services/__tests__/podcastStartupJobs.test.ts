/**
 * The two podcast jobs that run at startup do their work once: the category backfill asks Apple for many shows in
 * one request, and cached episodes are measured once, not on every boot. Real database and Redis; a local server
 * plays Apple, and the cache folder is a temporary one (music-metadata is the suite's stub).
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { parseFile } from "music-metadata";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { assignMissingCategories } from "../podcastCatalog";
import { measureCachedEpisodeLengths } from "../podcastDownload";

const IDS = ["9100001", "9100002", "9100003"];
let host: http.Server;
let lookups: string[] = [];
let cacheRoot = "";
let originalCache = "";

beforeAll(async () => {
    host = http.createServer((req, res) => {
        lookups.push(req.url ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ resultCount: 3, results: IDS.map((id) => ({ kind: "podcast", collectionId: Number(id), feedUrl: `https://f.example.invalid/${id}`, genreIds: ["1495", "26"] })) }));
    });
    await new Promise<void>((ok) => host.listen(0, "127.0.0.1", () => ok()));
    process.env.ITUNES_BASE_URL = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    await waitForRedisReady();
    cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kima-startup-"));
    originalCache = config.music.transcodeCachePath;
    config.music.transcodeCachePath = path.join(cacheRoot, "transcodes");
});

afterAll(async () => {
    delete process.env.ITUNES_BASE_URL;
    config.music.transcodeCachePath = originalCache;
    await prisma.podcast.deleteMany({ where: { id: { startsWith: "pod_startup" } } });
    await new Promise<void>((ok) => host.close(() => ok()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
});

it("fills missing categories for many shows with one request to Apple", async () => {
    const keys = await redisClient.keys("podcasts:lookup:*");
    if (keys.length) await redisClient.del(...keys);
    await prisma.podcast.deleteMany({ where: { id: { startsWith: "pod_startup" } } });
    for (const id of IDS) {
        await prisma.podcast.create({ data: { id: `pod_startup_${id}`, feedUrl: `https://f.example.invalid/${id}`, title: id, itunesId: id } });
    }
    lookups = [];
    expect(await assignMissingCategories()).toBe(3);
    expect(lookups.filter((u) => u.startsWith("/lookup"))).toHaveLength(1);
    expect((await prisma.podcast.findUniqueOrThrow({ where: { id: `pod_startup_${IDS[0]}` } })).categoryIds).toEqual([1495]);
});

it("measures cached episodes once, not on every start", async () => {
    const dir = path.join(cacheRoot, "podcast-audio");
    await fs.promises.mkdir(dir, { recursive: true });
    await prisma.podcast.create({
        data: {
            id: "pod_startup_len", feedUrl: "https://f.example.invalid/len", title: "Len",
            episodes: { create: [{ id: "pod_startup_ep", guid: "l1", title: "Ep", audioUrl: "https://a.invalid/1.mp3", duration: 4414, publishedAt: new Date() }] },
        },
    });
    await fs.promises.writeFile(path.join(dir, "pod_startup_ep.mp3"), "audio");
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockResolvedValue({ format: { duration: 5167.6 } });

    expect(await measureCachedEpisodeLengths()).toBe(1);
    expect((await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: "pod_startup_ep" } })).duration).toBe(5168);
    expect(await measureCachedEpisodeLengths()).toBe(0);
    expect(parseFile).toHaveBeenCalledTimes(1);
});

it("tries again, on later starts, only the cached files it could not read", async () => {
    const dir = path.join(cacheRoot, "podcast-audio");
    await fs.promises.rm(path.join(dir, ".lengths-measured"), { force: true });
    await prisma.podcast.create({
        data: {
            id: "pod_startup_len2", feedUrl: "https://f.example.invalid/len2", title: "Len2",
            episodes: { create: [{ id: "pod_startup_ep2", guid: "l2", title: "Ep2", audioUrl: "https://a.invalid/2.mp3", duration: 100, publishedAt: new Date() }] },
        },
    });
    await fs.promises.writeFile(path.join(dir, "pod_startup_ep2.mp3"), "audio");
    (parseFile as jest.Mock).mockReset();
    // First start: the earlier episode reads, this one cannot be read.
    (parseFile as jest.Mock).mockImplementation(async (file: string) =>
        file.endsWith("pod_startup_ep2.mp3") ? Promise.reject(new Error("busy disk")) : { format: { duration: 5167.6 } },
    );
    await measureCachedEpisodeLengths();
    expect((await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: "pod_startup_ep2" } })).duration).toBe(100);

    // Next start: only that file is tried, and now it reads.
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockResolvedValue({ format: { duration: 130.4 } });
    expect(await measureCachedEpisodeLengths()).toBe(1);
    expect((parseFile as jest.Mock).mock.calls.map((c) => path.basename(c[0]))).toEqual(["pod_startup_ep2.mp3"]);
    expect((await prisma.podcastEpisode.findUniqueOrThrow({ where: { id: "pod_startup_ep2" } })).duration).toBe(130);

    // And after that, nothing is left to try.
    expect(await measureCachedEpisodeLengths()).toBe(0);
    expect(parseFile).toHaveBeenCalledTimes(1);
});
