/**
 * A show's categories come from its feed's channel-level itunes:category tags, nested ones included, however
 * the feed writes them; a "not modified" answer counts only for a request that named an earlier copy. Real parser
 * and fetch guard; a local server plays the feed host under a public name.
 */
import http from "http";
import type { AddressInfo } from "net";
import { FeedReadError, rssParserService } from "../rss-parser";
import { publicUrl, routePublicHost } from "../../__tests__/helpers/publicHost";

const FEED = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show</title>
<itunes:category text="Society &amp; Culture"><itunes:category text="Documentary"/></itunes:category>
<itunes:category text='Comedy'/>
<itunes:category text="Comedy"/>
<item><title>Ep</title><guid>g1</guid><pubDate>Mon, 13 Oct 2026 10:00:00 GMT</pubDate>
<itunes:category text="Not The Show's"/>
<enclosure url="https://cdn.example.invalid/1.mp3" length="1000" type="audio/mpeg"/></item></channel></rss>`;

let host: http.Server;
let base = "";

beforeAll(async () => {
    host = http.createServer((req, res) => {
        if (req.url === "/always-304.xml") {
            res.writeHead(304);
            return res.end();
        }
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(FEED);
    });
    await new Promise<void>((ok) => host.listen(0, "127.0.0.1", () => ok()));
    routePublicHost();
    base = publicUrl((host.address() as AddressInfo).port);
});

afterAll(() => {
    jest.restoreAllMocks();
    return new Promise<void>((ok) => host.close(() => ok()));
});

it("reads nested, single-quoted and entity-written categories once each, and none from an episode", async () => {
    const feed = await rssParserService.parseFeed(`${base}/feed.xml`);
    expect(feed.podcast.categoryNames).toEqual(["Society & Culture", "Documentary", "Comedy"]);
});

it("a 304 to a request that named no earlier copy is a feed that could not be read, a 304 to a refresh is not modified", async () => {
    await expect(rssParserService.parseFeed(`${base}/always-304.xml`)).rejects.toBeInstanceOf(FeedReadError);
    expect(await rssParserService.parseFeed(`${base}/always-304.xml`, { etag: '"v1"' })).toEqual({ notModified: true });
});
