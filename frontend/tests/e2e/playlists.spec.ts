import { test, expect } from "@playwright/test";
import { loginAsTestUser, getAuthToken, skipIfEmptyLibrary, username, password } from "./fixtures/test-helpers";

const TEST_PLAYLIST_NAME = `e2e-test-${Date.now()}`;

test.describe("Playlists", () => {
    // Playlists this run made, including one created through the page, which no test deletes by id.
    test.afterAll(async ({ request }) => {
        const loginRes = await request.post("/api/auth/login", { data: { username, password } });
        if (!loginRes.ok()) return;
        const auth = { Authorization: `Bearer ${((await loginRes.json()) as { token: string }).token}` };
        const listRes = await request.get("/api/playlists?limit=100", { headers: auth });
        if (!listRes.ok()) return;
        const playlists = (await listRes.json()) as { id: string; name: string }[];
        for (const p of playlists.filter((p) => p.name === TEST_PLAYLIST_NAME)) {
            await request.delete(`/api/playlists/${p.id}`, { headers: auth });
        }
    });

    test.beforeEach(async ({ page }) => {
        await loginAsTestUser(page);
    });

    test("playlists page loads", async ({ page }) => {
        await page.goto("/playlists");
        await page.waitForLoadState("domcontentloaded");

        await expect(page.locator("body")).toBeVisible();
        await expect(page).toHaveURL(/playlists/);
    });

    test("create playlist via inline form", async ({ page }) => {
        await page.goto("/playlists");
        await page.waitForLoadState("domcontentloaded");

        // Click the "Create" ActionButton in the main page toolbar (not the sidebar).
        // The sidebar has a "Create playlist" button that appears first in DOM order,
        // so we scope the search to <main> to avoid it.
        const createBtn = page.locator("main").getByRole("button", { name: "Create" }).first();
        await createBtn.click();

        // The inline form should appear with the playlist name input.
        // Two CreatePanel instances can be visible simultaneously (toolbar + empty-state),
        // so use .first() to avoid strict mode violation.
        const nameInput = page.getByPlaceholder("Playlist name...").first();
        await expect(nameInput).toBeVisible({ timeout: 5_000 });

        await nameInput.fill(TEST_PLAYLIST_NAME);
        // Submit by pressing Enter -- avoids button selector ambiguity
        // (sidebar has a disabled "Create" button that appears first in DOM order)
        await nameInput.press("Enter");

        await page.waitForURL(/\/playlist\//, { timeout: 15_000 });
        await expect(page).toHaveURL(/\/playlist\//);
    });

    test("created playlist appears in playlist list", async ({ page }) => {
        const token = await getAuthToken(page);
        const response = await page.request.post("/api/playlists", {
            data: { name: TEST_PLAYLIST_NAME, isPublic: false },
            headers: { Authorization: `Bearer ${token}` },
        });

        expect(response.status(), "creating the test playlist").toBeLessThan(300);
        const { id } = (await response.json()) as { id: string };
        try {
            await page.goto("/playlists");
            await page.waitForLoadState("domcontentloaded");
            await expect(page.getByText(TEST_PLAYLIST_NAME, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
        } finally {
            await page.request.delete(`/api/playlists/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        }
    });

    test("add track to playlist from album page", async ({ page }) => {
        const token = await getAuthToken(page);

        const res = await page.request.post("/api/playlists", {
            data: { name: TEST_PLAYLIST_NAME, isPublic: false },
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok()) {
            test.skip();
            return;
        }
        const created = await res.json();
        const playlistId: string = created.id;

        await skipIfEmptyLibrary(page);

        await page.goto("/collection?tab=albums");
        const firstAlbum = page.locator('a[href^="/album/"]').first();
        await firstAlbum.waitFor({ timeout: 10_000 });
        await firstAlbum.click();
        await page.waitForURL(/\/album\//);

        // Hover the first track to reveal the "Add to playlist" button
        const firstTrackRow = page.locator("[data-track-row]").first();
        await firstTrackRow.waitFor({ timeout: 10_000 });
        await firstTrackRow.hover();

        const addToPlaylistBtn = firstTrackRow.getByLabel("Add to playlist");
        await expect(addToPlaylistBtn).toBeVisible({ timeout: 5_000 });
        await addToPlaylistBtn.click();

        // A playlist selector modal should appear -- scope to the overlay to avoid matching
        // the sidebar playlist entry which sits behind the modal.
        const modal = page.locator("[role='dialog'], .fixed.inset-0").last();
        const playlistOption = modal.getByText(TEST_PLAYLIST_NAME, { exact: false }).first();
        await expect(playlistOption).toBeVisible({ timeout: 5_000 });
        await playlistOption.click();

        await page.goto(`/playlist/${playlistId}`);
        await page.waitForLoadState("domcontentloaded");

        // Playlist should have at least 1 track (rows use data-track-index on playlist page)
        await expect(page.locator("[data-track-index]").first()).toBeVisible({ timeout: 10_000 });

        await page.request.delete(`/api/playlists/${playlistId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    });

    test("remove track from playlist", async ({ page }) => {
        const token = await getAuthToken(page);

        const createRes = await page.request.post("/api/playlists", {
            data: { name: TEST_PLAYLIST_NAME, isPublic: false },
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!createRes.ok()) {
            test.skip();
            return;
        }
        const created = await createRes.json();
        const playlistId: string = created.id;

        const tracksRes = await page.request.get("/api/library/tracks?limit=1", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!tracksRes.ok()) {
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            test.skip();
            return;
        }
        const tracksData = await tracksRes.json();
        const firstTrackId: string = (tracksData.tracks ?? tracksData)[0]?.id;

        if (!firstTrackId) {
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            test.skip();
            return;
        }

        await page.request.post(`/api/playlists/${playlistId}/items`, {
            data: { trackId: firstTrackId },
            headers: { Authorization: `Bearer ${token}` },
        });

        await page.goto(`/playlist/${playlistId}`);
        await page.waitForLoadState("domcontentloaded");

        // Hover the track row to reveal "Remove from playlist" button
        const trackRow = page.locator("[data-track-index]").first();
        await trackRow.waitFor({ timeout: 10_000 });
        await trackRow.hover();

        const removeBtn = page.getByTitle(/remove from playlist/i).first();
        await expect(removeBtn).toBeVisible({ timeout: 5_000 });
        await removeBtn.click();

        await expect(page.getByText(/no tracks|empty|0 song/i).first()).toBeVisible({ timeout: 10_000 });

        await page.request.delete(`/api/playlists/${playlistId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    });

    test("delete playlist", async ({ page }) => {
        const token = await getAuthToken(page);

        const createRes = await page.request.post("/api/playlists", {
            data: { name: TEST_PLAYLIST_NAME, isPublic: false },
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!createRes.ok()) {
            test.skip();
            return;
        }
        const created = await createRes.json();
        const playlistId: string = created.id;

        await page.goto(`/playlist/${playlistId}`);
        await page.waitForLoadState("domcontentloaded");

        const deleteBtn = page.getByTitle("Delete Playlist");
        await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
        await deleteBtn.click();

        const confirmBtn = page.getByRole("button", { name: "Delete", exact: true });
        await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
        await confirmBtn.click();

        await page.waitForURL(/\/(playlists|$)/, { timeout: 10_000 });
        await expect(page).not.toHaveURL(new RegExp(`/playlist/${playlistId}`));
    });

    test("play all tracks in playlist", async ({ page }) => {
        const token = await getAuthToken(page);

        const createRes = await page.request.post("/api/playlists", {
            data: { name: TEST_PLAYLIST_NAME, isPublic: false },
            headers: { Authorization: `Bearer ${token}` },
        });

        if (!createRes.ok()) {
            test.skip();
            return;
        }
        const created = await createRes.json();
        const playlistId: string = created.id;

        const tracksRes = await page.request.get("/api/library/tracks?limit=3", {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!tracksRes.ok()) {
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            test.skip();
            return;
        }
        const tracksData = await tracksRes.json();
        const trackList: Array<{ id: string }> = tracksData.tracks ?? tracksData;

        if (trackList.length === 0) {
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            test.skip(true, "No tracks in library -- skipping (empty CI container)");
            return;
        }

        for (const t of trackList.slice(0, 3)) {
            await page.request.post(`/api/playlists/${playlistId}/items`, {
                data: { trackId: t.id },
                headers: { Authorization: `Bearer ${token}` },
            });
        }

        await page.goto(`/playlist/${playlistId}`);
        await page.waitForLoadState("domcontentloaded");

        const playAllBtn = page.getByLabel("Play all").or(page.getByTitle("Play all")).first();
        await expect(playAllBtn).toBeVisible({ timeout: 5_000 });
        await playAllBtn.click();

        // Pause button should appear -- playback started (target FullPlayer title to avoid ambiguity)
        await expect(page.getByTitle("pause", { exact: true })).toBeVisible({ timeout: 8_000 });

        await page.request.delete(`/api/playlists/${playlistId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
    });
});
