/**
 * Song previews and an artist's popular songs on Deezer's recorded replies (fixtures/deezer).
 * Deezer no longer honours its artist:"…" track:"…" search, so a preview is asked for plainly; a full title beats
 * one that only agrees without Deezer's credits; a well-known song buried under covers is found among its artist's
 * own popular songs, fetched once per artist, and asked for again for a link that still plays (Deezer's last 15
 * minutes); a song neither finds has no preview; and an error Deezer sends as a normal reply is a failed request,
 * never remembered as "none".
 */
import fs from "fs";
import path from "path";

const mockRateLimitedGet = jest.fn();
// Only the network is stood in for: the reply check runs on the body as the real helper runs it.
jest.mock("../httpClient", () => require("./helpers/deezerMocks").httpClientMock(() => mockRateLimitedGet));
jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
const mockCache = new Map<string, string>();
jest.mock("../../utils/cacheWrapper", () => require("./helpers/deezerMocks").memoryCacheMock(mockCache));

import { logger } from "../../utils/logger";
import { deezerService } from "../deezer";

type Track = {
    id?: number;
    title: string;
    title_short?: string;
    preview?: string;
    duration?: number;
    rank?: number;
    artist?: { id: number; name: string };
    album?: { title?: string; cover_medium?: string };
};
type Reply = { data?: Track[]; error?: { code: number; message: string } };
/** A list reply, or one track's own reply. */
type Recorded = { replies: { path: string; params: Record<string, unknown> | null; reply: Reply & Partial<Track> }[] };

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/deezer", name), "utf8"));
const load = (slug: string): Recorded => fixture(`preview-${slug}.json`);
/** One of Deezer's real error replies, by code. */
const deezerError = (code: number): Reply =>
    (fixture("errors.json").replies as { reply: Reply }[]).find((r) => r.reply.error?.code === code)!.reply;

/** Answers each request with the recorded reply to the same path and parameters; any other request fails. */
function replay(recorded: Recorded): void {
    mockRateLimitedGet.mockImplementation(async (_service: string, url: string, config?: { params?: Record<string, unknown> }) => {
        const asked = url.replace("https://api.deezer.com", "");
        const hit = recorded.replies.find((r) => r.path === asked && JSON.stringify(r.params ?? null) === JSON.stringify(config?.params ?? null));
        if (!hit) throw new Error(`no recorded reply for ${asked} ${JSON.stringify(config?.params)}`);
        return hit.reply;
    });
}

const askedPaths = () => mockRateLimitedGet.mock.calls.map(([, url]) => String(url).replace("https://api.deezer.com", ""));
const byArtistAndTitle = (tracks: Track[], artist: string, field: "title" | "title_short", title: string) =>
    tracks.find((t) => t.preview && t.artist?.name === artist && t[field] === title);

beforeEach(() => {
    jest.clearAllMocks();
    mockCache.clear();
});

describe("deezerService.getTrackPreview", () => {
    it("asks plainly and serves the first result whose artist and full title agree", async () => {
        const recorded = load("radiohead-creep");
        replay(recorded);
        const expected = byArtistAndTitle(recorded.replies[0].reply.data!, "Radiohead", "title", "Creep")?.preview;

        expect(expected).toBeTruthy();
        expect(await deezerService.getTrackPreview("Radiohead", "Creep")).toBe(expected);
        expect(mockRateLimitedGet.mock.calls[0][2].params.q).toBe("Radiohead Creep");
        expect(askedPaths()).toEqual(["/search/track"]);
    });

    it("prefers the song itself to a same-artist version that only agrees without its parenthesis", async () => {
        // The same real results, with "Creep (Acoustic)" (short title "Creep") moved above "Creep".
        const recorded = load("radiohead-creep");
        const [studio, acoustic, ...rest] = recorded.replies[0].reply.data!;
        expect([studio.title, acoustic.title, acoustic.title_short]).toEqual(["Creep", "Creep (Acoustic)", "Creep"]);
        recorded.replies[0].reply.data = [acoustic, studio, ...rest];
        replay(recorded);

        expect(await deezerService.getTrackPreview("Radiohead", "Creep")).toBe(studio.preview);
    });

    it("matches a title Deezer lists with its credits, after looking for the full title in both lists", async () => {
        const recorded = load("daft-punk-get-lucky");
        replay(recorded);
        const [search, , top] = recorded.replies;
        // The search lists it only with its credits ("Get Lucky (… feat. Pharrell Williams and Nile Rodgers)").
        expect(byArtistAndTitle(search.reply.data!, "Daft Punk", "title", "Get Lucky")).toBeUndefined();
        const expected =
            byArtistAndTitle(top.reply.data!, "Daft Punk", "title", "Get Lucky") ??
            byArtistAndTitle(search.reply.data!, "Daft Punk", "title_short", "Get Lucky");

        expect(expected?.preview).toBeTruthy();
        expect(await deezerService.getTrackPreview("Daft Punk", "Get Lucky")).toBe(expected?.preview);
        expect(askedPaths()).toEqual(["/search/track", "/search/artist", "/artist/27/top"]);
    });

    it("finds a song buried under covers among the most-followed same-named artist's popular songs", async () => {
        const recorded = load("adele-hello");
        replay(recorded);
        const [search, , top, single] = recorded.replies;
        // The recorded search holds covers and remixes, none of them Adele's own "Hello".
        expect(byArtistAndTitle(search.reply.data!, "Adele", "title", "Hello")).toBeUndefined();
        const listed = byArtistAndTitle(top.reply.data!, "Adele", "title", "Hello")!;
        // The single-track reply carries a newer link than the one in the popular list.
        expect(single.reply.preview).toBeTruthy();
        expect(single.reply.preview).not.toBe(listed.preview);

        expect(await deezerService.getTrackPreview("Adele", "Hello")).toBe(single.reply.preview);
        // 75798 is the Adele with millions of fans; the search ranks a namesake with a few hundred first.
        expect(askedPaths()).toEqual(["/search/track", "/search/artist", "/artist/75798/top", `/track/${listed.id ?? ""}`]);
    });

    it("takes the song itself from the artist's popular songs over a version the search holds", async () => {
        // The real search, without the studio "Creep": only "Creep (Acoustic)" (short title "Creep") is left in it.
        const recorded = load("radiohead-creep");
        const search = recorded.replies[0].reply;
        search.data = search.data!.filter((t) => !(t.artist?.name === "Radiohead" && t.title === "Creep"));
        expect(byArtistAndTitle(search.data, "Radiohead", "title_short", "Creep")?.title).toBe("Creep (Acoustic)");
        replay(recorded);
        const single = recorded.replies[3];

        expect(await deezerService.getTrackPreview("Radiohead", "Creep")).toBe(single.reply.preview);
        expect(askedPaths()).toEqual(["/search/track", "/search/artist", "/artist/399/top", single.path]);
    });

    it("moves on to the next match when the song found in the popular list has left Deezer", async () => {
        const recorded = load("radiohead-creep");
        const search = recorded.replies[0].reply;
        search.data = search.data!.filter((t) => !(t.artist?.name === "Radiohead" && t.title === "Creep"));
        const acoustic = byArtistAndTitle(search.data, "Radiohead", "title_short", "Creep")!;
        recorded.replies[3].reply = deezerError(800);
        replay(recorded);

        expect(await deezerService.getTrackPreview("Radiohead", "Creep")).toBe(acoustic.preview);
    });

    it("asks for each popular-list song once, moving past one that has left Deezer to the next match there", async () => {
        // Without the studio "Creep" or its acoustic take in the search, only the popular list holds them.
        const recorded = load("radiohead-creep");
        const search = recorded.replies[0].reply;
        search.data = search.data!.filter((t) => !(t.artist?.name === "Radiohead" && t.title_short === "Creep"));
        recorded.replies[3].reply = deezerError(800);
        replay(recorded);
        const acoustic = recorded.replies.find((r) => r.path === "/track/2215315187")!.reply;
        expect(acoustic.title).toBe("Creep (Acoustic)");

        expect(await deezerService.getTrackPreview("Radiohead", "Creep")).toBe(acoustic.preview);
        expect(askedPaths().filter((p) => p.startsWith("/track/"))).toEqual(["/track/138547415", "/track/2215315187"]);
    });

    it("has no preview when neither the search nor that name's artist holds the song", async () => {
        // Deezer's "Purcell" is a small namesake, not Henry Purcell: classical credits rarely match by name.
        replay(load("purcell-lament"));

        expect(await deezerService.getTrackPreview("Purcell", "When I Am Laid in Earth")).toBeNull();
        expect(askedPaths()).toEqual(["/search/track", "/search/artist", "/artist/4136889/top"]);
        expect(logger.error).not.toHaveBeenCalled();
    });
});

describe("caching", () => {
    it("keeps the answer, and asks for an artist's popular songs once", async () => {
        replay(load("adele-hello"));

        await deezerService.getFreshTrackPreview("Adele", "Hello");
        mockRateLimitedGet.mockClear();
        await deezerService.getFreshTrackPreview("Adele", "Hello");
        expect(askedPaths()).toEqual(["/search/track", "/track/1174604652"]);

        await deezerService.getTrackPreview("Adele", "Hello");
        expect([...mockCache.keys()].sort()).toEqual(["deezer:artist-top-tracks:adele", "deezer:track-preview:adele:hello"]);
    });

    it("an error Deezer sends as a normal reply is a failed request, not a remembered 'none'", async () => {
        mockRateLimitedGet.mockResolvedValue(deezerError(500));

        expect(await deezerService.getTrackPreview("Adele", "Hello")).toBeNull();
        expect(mockCache.size).toBe(0);
        expect(logger.error).toHaveBeenCalled();
    });
});

describe("deezerService.getArtistTopTracks", () => {
    it("is the artist's recorded popular songs, cut to the page's ten, from the list the previews share", async () => {
        const recorded = load("adele-hello");
        replay(recorded);
        const raw = recorded.replies[2].reply.data!;

        const top = await deezerService.getArtistTopTracks("Adele", 10);

        expect(top).toHaveLength(10);
        expect(top[0]).toEqual({
            title: raw[0].title,
            artist: "Adele",
            album: raw[0].album?.title,
            coverUrl: raw[0].album?.cover_medium,
            previewUrl: raw[0].preview,
            durationMs: raw[0].duration! * 1000,
            rank: raw[0].rank,
        });
        mockRateLimitedGet.mockClear();
        await deezerService.getFreshTrackPreview("Adele", "Hello");
        expect(askedPaths()).toEqual(["/search/track", "/track/1174604652"]);
    });

    it("is empty when Deezer has no data for the artist, which is an answer, not a failure", async () => {
        const recorded = load("adele-hello");
        recorded.replies[2].reply = deezerError(800);
        replay(recorded);

        await expect(deezerService.getArtistTopTracks("Adele", 10)).resolves.toEqual([]);
    });
});
