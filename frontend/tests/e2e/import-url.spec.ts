import { test, expect, type Page } from "@playwright/test";
import { loginAsTestUser, getAuthToken } from "./fixtures/test-helpers";

/** POST /api/browse/playlists/parse: which service a pasted playlist URL belongs to. */
test.describe("Import URL parsing", () => {
    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    async function parse(page: Page, url: string) {
        const token = await getAuthToken(page);
        return page.request.post("/api/browse/playlists/parse", {
            data: { url },
            headers: { Authorization: `Bearer ${token}` },
        });
    }

    async function expectParsed(
        page: Page,
        url: string,
        expected: { source: string; type: string; id: string },
    ) {
        const res = await parse(page, url);
        expect(res.ok()).toBe(true);
        expect(await res.json()).toMatchObject(expected);
    }

    test("Deezer playlist URL is parsed correctly", async ({ page }) => {
        await expectParsed(page, "https://www.deezer.com/playlist/1313621735", {
            source: "deezer",
            type: "playlist",
            id: "1313621735",
        });
    });

    test("Spotify playlist URL is parsed correctly", async ({ page }) => {
        await expectParsed(page, "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", {
            source: "spotify",
            type: "playlist",
            id: "37i9dQZF1DXcBWIGoYBM5M",
        });
    });

    test("YouTube Music playlist URL is parsed correctly", async ({ page }) => {
        await expectParsed(page, "https://music.youtube.com/playlist?list=PLRBp0Fe2GpgmgoscNFLxNyBVSFVdYmFbR", {
            source: "youtube",
            type: "playlist",
            id: "PLRBp0Fe2GpgmgoscNFLxNyBVSFVdYmFbR",
        });
    });

    test("youtube.com playlist URL is parsed correctly", async ({ page }) => {
        await expectParsed(page, "https://www.youtube.com/playlist?list=PLRBp0Fe2GpgmgoscNFLxNyBVSFVdYmFbR", {
            source: "youtube",
            type: "playlist",
            id: "PLRBp0Fe2GpgmgoscNFLxNyBVSFVdYmFbR",
        });
    });

    test("invalid URL returns 400", async ({ page }) => {
        const res = await parse(page, "https://soundcloud.com/artist/track");
        expect(res.status()).toBe(400);
        const data = await res.json() as { error: string };
        expect(data.error).toMatch(/YouTube/i);
    });

    test("missing URL body returns 400", async ({ page }) => {
        const token = await getAuthToken(page);
        const res = await page.request.post("/api/browse/playlists/parse", {
            data: {},
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status()).toBe(400);
    });
});
