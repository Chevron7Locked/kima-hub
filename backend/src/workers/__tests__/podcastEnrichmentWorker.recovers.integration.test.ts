/**
 * A show whose feed could not be read once (a host or the network down for a moment) stops being listed as failing
 * the next time its feed is read; a feed that still cannot be read stays listed. Real database, worker and address
 * check; a local server plays the feed's host under a public name.
 */
import http from "http";
import type { AddressInfo } from "net";
import type { Job } from "bullmq";
import { prisma } from "../../utils/db";
import { processPodcastJob } from "../podcastEnrichmentWorker";
import { enrichmentFailureService } from "../../services/enrichmentFailureService";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { publicUrl, routePublicHost } from "../../__tests__/helpers/publicHost";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Recovering Show</title>
<item><title>One</title><guid>rec-1</guid><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
<enclosure url="https://example.com/1.mp3" type="audio/mpeg" length="1"/></item></channel></rss>`;

let host: http.Server;
let base = "";
const P = "pod_recovers";

beforeAll(async () => {
    host = http.createServer((req, res) => {
        if (req.url === "/down.xml") {
            res.writeHead(503);
            return res.end("down");
        }
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(FEED);
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    base = publicUrl((host.address() as AddressInfo).port);
});

beforeEach(() => routePublicHost());

afterEach(async () => {
    jest.restoreAllMocks();
    await prisma.enrichmentFailure.deleteMany({ where: { entityId: { in: [`${P}-up`, `${P}-down`] } } });
    await prisma.podcast.deleteMany({ where: { id: { in: [`${P}-up`, `${P}-down`] } } });
});

afterAll(async () => {
    await new Promise((r) => host.close(r));
    await closeEngineConnections();
});

const job = (podcastId: string) => ({ data: { podcastId, podcastTitle: "Recovering Show" } }) as Job;
const unresolved = (entityId: string) =>
    prisma.enrichmentFailure.count({ where: { entityType: "podcast", entityId, resolved: false } });

it("clears an earlier failure once the feed is read, and keeps it while the feed still fails", async () => {
    for (const [id, path] of [[`${P}-up`, "/feed.xml"], [`${P}-down`, "/down.xml"]]) {
        await prisma.podcast.create({ data: { id, feedUrl: `${base}${path}`, title: "Recovering Show" } });
        await enrichmentFailureService.recordFailure({
            entityType: "podcast",
            entityId: id,
            entityName: "Recovering Show",
            errorMessage: "Could not read podcast feed: getaddrinfo EAI_AGAIN feeds.example.com",
        });
    }

    await processPodcastJob(job(`${P}-up`));
    expect(await unresolved(`${P}-up`)).toBe(0);

    await expect(processPodcastJob(job(`${P}-down`))).rejects.toThrow(/Could not read podcast feed/);
    expect(await unresolved(`${P}-down`)).toBe(1);
});
