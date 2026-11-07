/** POST /browse/playlists/parse: which site a pasted playlist address belongs to. The route and the address readers are real. */
jest.mock("../../middleware/auth", () => ({ requireAuthOrToken: (_req: unknown, _res: unknown, next: () => void) => next() }));

import express from "express";
import request from "supertest";
import browseRoutes from "../browse";

const app = express().use(express.json()).use("/browse", browseRoutes);
const parse = (body: unknown) => request(app).post("/browse/playlists/parse").send(body as object);
const REFUSED = { error: "Invalid or unsupported URL. Please provide a Spotify, Deezer, or YouTube playlist URL." };

describe("an address that is not a music link", () => {
    it.each([
        "https://youtube.com.evil.invalid/playlist?list=x",
        "https://notyoutube.com/watch?v=abc&list=x",
        "https://music.youtube.com.evil.invalid/playlist?list=x",
        "https://youtube.com@evil.invalid/playlist?list=x",
        "https://evil.invalid/?list=x&u=youtube.com",
        "https://evil.invalid/spotify.com/playlist/abc",
        "https://evil.invalid/deezer.com/playlist/123",
        "file:///etc/passwd",
        "ftp://youtube.com/playlist?list=x",
        "javascript:alert(1)",
        "https://",
        "spotify:playlist:abc",
        "open.spotify.com/playlist/abc",
    ])("%s is a 400", async (url) => {
        const res = await parse({ url });
        expect(res.status).toBe(400);
        expect(res.body).toEqual(REFUSED);
    });

    it.each([42, {}, ["https://www.youtube.com/playlist?list=x"], true])("%p as the url is a 400, not a server error", async (url) => {
        const res = await parse({ url });
        expect(res.status).toBe(400);
    });
});

describe("a playlist address on a supported site", () => {
    it.each([
        ["https://www.deezer.com/playlist/1313621735", { source: "deezer", type: "playlist", id: "1313621735", url: "https://www.deezer.com/playlist/1313621735" }],
        ["https://www.deezer.com/en/playlist/1313621735", { source: "deezer", type: "playlist", id: "1313621735", url: "https://www.deezer.com/playlist/1313621735" }],
        ["https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", { source: "spotify", type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M", url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" }],
        ["https://www.youtube.com/playlist?list=PLRBp0Fe2GpgmgoscNFLxNyBVSFVdYmFbR", { source: "youtube", type: "playlist", id: "PLRBp0Fe2GpgmgoscNFLxNyBVSFVdYmFbR", url: "https://www.youtube.com/playlist?list=PLRBp0Fe2GpgmgoscNFLxNyBVSFVdYmFbR" }],
        ["https://music.youtube.com/playlist?list=OLAK5uy_x", { source: "youtube", type: "playlist", id: "OLAK5uy_x", url: "https://music.youtube.com/playlist?list=OLAK5uy_x" }],
        ["https://youtu.be/abc?list=PL123", { source: "youtube", type: "playlist", id: "PL123", url: "https://youtu.be/abc?list=PL123" }],
        ["https://m.youtube.com/watch?v=abc&list=PL123", { source: "youtube", type: "playlist", id: "PL123", url: "https://m.youtube.com/watch?v=abc&list=PL123" }],
    ])("%s is read as before", async (url, expected) => {
        const res = await parse({ url });
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expected);
    });

    it("hands the parsed address back for YouTube, not the raw one", async () => {
        const res = await parse({ url: "https://youtu.be\\@evil.invalid/abc?list=PL123" });
        expect(res.body.url).toBe("https://youtu.be/@evil.invalid/abc?list=PL123");
    });

    it.each(["https://www.youtube.com/watch?v=abc", "https://open.spotify.com/album/abc", "https://soundcloud.com/artist/sets/mix"])(
        "%s has no playlist in it and is a 400",
        async (url) => {
            const res = await parse({ url });
            expect(res.status).toBe(400);
            expect(res.body).toEqual(REFUSED);
        },
    );

    it("needs a url", async () => {
        const res = await parse({});
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: "URL is required" });
    });
});
