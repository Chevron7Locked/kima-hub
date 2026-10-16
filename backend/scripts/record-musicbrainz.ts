/**
 * Records MusicBrainz's real replies for tests. Runs Kima's own MusicBrainz service through a local proxy that
 * forwards each request to musicbrainz.org and saves the reply under the exact path and query the service sent;
 * `__tests__/helpers/replayServer.ts` serves them back. Each call adds to the fixture file.
 *
 *   npx tsx scripts/record-musicbrainz.ts <fixture-name> <method> '<json arguments array>'
 *   e.g. npx tsx scripts/record-musicbrainz.ts teardrop identifyRecording \
 *          '[{"title":"Teardrop","artists":["Massive Attack"],"durationSec":330}]'
 *
 * Use public recordings only: fixtures are committed. The service caches answers in Redis, so the script refuses
 * a REDIS_URL already holding MusicBrainz cache keys, and removes the ones its own run made.
 */
import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";

const UPSTREAM = "https://musicbrainz.org/ws/2";

async function main() {
    const [name, method, argsJson] = process.argv.slice(2);
    if (!name || !method || !argsJson) throw new Error("usage: record-musicbrainz.ts <fixture-name> <method> '<json args>'");
    const file = path.join(__dirname, "..", "src", "__tests__", "fixtures", "musicbrainz", `${name}.json`);
    const recording = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : { source: UPSTREAM, recordedAt: "", replies: {} as Record<string, unknown> };

    const proxy = http.createServer(async (req, res) => {
        const request = req.url ?? "";
        const upstream = await fetch(UPSTREAM + request, {
            headers: { "User-Agent": String(req.headers["user-agent"] ?? ""), Accept: "application/json" },
        });
        const text = await upstream.text();
        recording.replies[request] = { status: upstream.status, body: JSON.parse(text) };
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(text);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    process.env.MUSICBRAINZ_BASE_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    const { redisClient, waitForRedisReady } = await import("../src/utils/redis");
    await waitForRedisReady();
    if ((await redisClient.keys("mb:*")).length > 0) {
        throw new Error("REDIS_URL holds MusicBrainz cache keys: an answer from the cache would not be recorded");
    }
    const { musicBrainzService } = await import("../src/services/musicbrainz");
    const service = musicBrainzService as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const result = await service[method](...JSON.parse(argsJson));
    console.log(JSON.stringify(result, null, 2));

    recording.recordedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(recording) + "\n");
    const made = await redisClient.keys("mb:*");
    if (made.length > 0) await redisClient.del(...made);
    await redisClient.quit();
    proxy.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
