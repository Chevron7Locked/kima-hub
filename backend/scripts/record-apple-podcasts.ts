/**
 * Records Apple's real podcast-catalog replies for tests: each request path is fetched from itunes.apple.com and
 * its reply saved under that exact path, as `services/podcastCatalog.ts` sends it; `__tests__/helpers/
 * replayServer.ts` serves them back. Each call adds to the fixture file.
 *
 *   npx tsx scripts/record-apple-podcasts.ts <fixture-name> '<request path>' ['<request path>' ...]
 *   e.g. npx tsx scripts/record-apple-podcasts.ts catalog '/lookup?id=1131414468&entity=podcast'
 */
import fs from "fs";
import path from "path";

const UPSTREAM = "https://itunes.apple.com";

async function main() {
    const [name, ...requests] = process.argv.slice(2);
    if (!name || requests.length === 0) throw new Error("usage: record-apple-podcasts.ts <fixture-name> '<path>' ...");
    const file = path.join(__dirname, "..", "src", "__tests__", "fixtures", "apple", `${name}.json`);
    const recording = fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, "utf8"))
        : { source: UPSTREAM, recordedAt: "", replies: {} as Record<string, unknown> };
    for (const request of requests) {
        const upstream = await fetch(UPSTREAM + request, { headers: { Accept: "application/json" } });
        recording.replies[request] = { status: upstream.status, body: JSON.parse(await upstream.text()) };
        console.log(`${upstream.status} ${request}`);
    }
    recording.recordedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(recording) + "\n");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
