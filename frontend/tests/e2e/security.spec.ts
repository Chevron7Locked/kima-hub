import { test, expect, Page } from "@playwright/test";
import { username, password } from "./fixtures/test-helpers";

/**
 * Against the full stack: IDOR with two real users, XSS in real rendering, mass
 * assignment, and error responses that leak nothing. Auth middleware and route
 * ownership are covered by backend unit tests.
 */

const ATTACKER_USER = `attacker_${Date.now()}`;
const ATTACKER_PASS = "AttackerPass123!";

test.describe("Security", () => {

    // ── IDOR ─────────────────────────────────────────────────────────────────

    test.describe("IDOR -- cross-user isolation", () => {
        test.beforeAll(async ({ request }) => {
            // The admin test user creates the attacker account; without admin rights this
            // fails and every test below fails at its own attacker login.
            try {
                const loginRes = await request.post("/api/auth/login", {
                    data: { username, password },
                });
                if (!loginRes.ok()) return;
                const { token } = await loginRes.json() as { token: string };
                await request.post("/api/auth/create-user", {
                    data: { username: ATTACKER_USER, password: ATTACKER_PASS, role: "user" },
                    headers: { Authorization: `Bearer ${token}` },
                });
            } catch {
                // Each test asserts the attacker login itself.
            }
        });

        /** The admin test user is the victim: it owns a private playlist, and the attacker is signed in too. */
        async function seedVictimPlaylist(page: Page, name: string) {
            const victimToken = await page.request.post("/api/auth/login", {
                data: { username, password },
            }).then(r => r.json()).then((b: { token: string }) => b.token);
            expect(victimToken, "security setup failed: victimToken").toBeTruthy();

            const createRes = await page.request.post("/api/playlists", {
                data: { name, isPublic: false },
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            expect(createRes.ok(), "security setup failed: createRes.ok()").toBeTruthy();
            const { id: playlistId } = await createRes.json() as { id: string };

            const attackerLoginRes = await page.request.post("/api/auth/login", {
                data: { username: ATTACKER_USER, password: ATTACKER_PASS },
            });
            expect(attackerLoginRes.ok(), "security setup failed: attackerLoginRes.ok()").toBeTruthy();
            const { token: attackerToken } = await attackerLoginRes.json() as { token: string };

            return { victimToken, attackerToken, playlistId };
        }

        test("attacker cannot READ victim's private playlist -- must be 403 not 404", async ({ page }) => {
            const { victimToken, attackerToken, playlistId } = await seedVictimPlaylist(page, `victim-private-${Date.now()}`);

            const readRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${attackerToken}` },
            });

            // Must be 403 (access denied), not 404 (which hides that the resource exists
            // and would mask a broken ownership check that silently falls through to not found)
            expect(readRes.status()).toBe(403);

            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
        });

        test("attacker cannot UPDATE victim's playlist -- name must be unchanged in DB after attempt", async ({ page }) => {
            const originalName = `victim-update-${Date.now()}`;
            const { victimToken, attackerToken, playlistId } = await seedVictimPlaylist(page, originalName);

            const updateRes = await page.request.put(`/api/playlists/${playlistId}`, {
                data: { name: "HIJACKED" },
                headers: { Authorization: `Bearer ${attackerToken}` },
            });
            expect(updateRes.status()).toBe(403);

            const verifyRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            expect(verifyRes.status()).toBe(200);
            const verified = await verifyRes.json() as { name: string };
            expect(verified.name).toBe(originalName); // unchanged

            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
        });

        test("attacker cannot DELETE victim's playlist -- resource must still exist after attempt", async ({ page }) => {
            const { victimToken, attackerToken, playlistId } = await seedVictimPlaylist(page, `victim-delete-${Date.now()}`);

            const deleteRes = await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${attackerToken}` },
            });
            expect(deleteRes.status()).toBe(403);

            const verifyRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            expect(verifyRes.status()).toBe(200);

            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
        });

        // The attacker account is this run's alone: the admin test user removes it, so runs leave no accounts behind.
        test.afterAll(async ({ request }) => {
            const loginRes = await request.post("/api/auth/login", { data: { username, password } });
            if (!loginRes.ok()) return;
            const auth = { Authorization: `Bearer ${((await loginRes.json()) as { token: string }).token}` };
            const usersRes = await request.get("/api/auth/users", { headers: auth });
            if (!usersRes.ok()) return;
            const users = (await usersRes.json()) as { id: string; username: string }[];
            const attacker = users.find((u) => u.username === ATTACKER_USER);
            if (attacker) await request.delete(`/api/auth/users/${attacker.id}`, { headers: auth });
        });
    });

    // ── XSS ──────────────────────────────────────────────────────────────────

    test.describe("XSS -- stored payload rendering", () => {

        test("script tag in playlist name does not execute in browser", async ({ page }) => {
            const loginRes = await page.request.post("/api/auth/login", { data: { username, password } });
            expect(loginRes.ok(), "security setup failed: loginRes.ok()").toBeTruthy();
            const { token } = await loginRes.json() as { token: string };

            const payload = `<script>window.__xss_script=true</script>xss-${Date.now()}`;
            const createRes = await page.request.post("/api/playlists", {
                data: { name: payload, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(createRes.ok(), "security setup failed: createRes.ok()").toBeTruthy();
            const { id: playlistId } = await createRes.json() as { id: string };

            await page.goto("/playlists");
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(1000);

            const xssExecuted = await page.evaluate(
                () => !!(window as unknown as Record<string, unknown>).__xss_script,
            );
            expect(xssExecuted).toBe(false);

            const injectedScripts = await page.locator("script").evaluateAll(
                (els) => els.filter((el) => el.textContent?.includes("__xss_script")).length,
            );
            expect(injectedScripts).toBe(0);

            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        });

        test("img onerror payload in playlist name does not execute in browser", async ({ page }) => {
            const loginRes = await page.request.post("/api/auth/login", { data: { username, password } });
            expect(loginRes.ok(), "security setup failed: loginRes.ok()").toBeTruthy();
            const { token } = await loginRes.json() as { token: string };

            const payload = `<img src=x onerror="window.__xss_onerror=true">xss-${Date.now()}`;
            const createRes = await page.request.post("/api/playlists", {
                data: { name: payload, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(createRes.ok(), "security setup failed: createRes.ok()").toBeTruthy();
            const { id: playlistId } = await createRes.json() as { id: string };

            await page.goto("/playlists");
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(1000);

            const xssExecuted = await page.evaluate(
                () => !!(window as unknown as Record<string, unknown>).__xss_onerror,
            );
            expect(xssExecuted).toBe(false);

            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        });
    });

    // ── Mass assignment ───────────────────────────────────────────────────────

    test.describe("Mass assignment", () => {

        test("POST /api/playlists ignores injected userId -- playlist owned by authenticated user", async ({ page }) => {
            const loginRes = await page.request.post("/api/auth/login", { data: { username, password } });
            expect(loginRes.ok(), "security setup failed: loginRes.ok()").toBeTruthy();
            const { token } = await loginRes.json() as { token: string };

            const res = await page.request.post("/api/playlists", {
                data: {
                    name: `mass-assign-${Date.now()}`,
                    isPublic: false,
                    userId: "injected-attacker-id",
                    role: "admin",
                },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.ok(), "security setup failed: res.ok()").toBeTruthy();
            const playlist = await res.json() as { id: string; userId: string };

            // Must belong to the real authenticated user, not the injected ID
            expect(playlist.userId).not.toBe("injected-attacker-id");
            expect(playlist.userId).toBeTruthy();

            await page.request.delete(`/api/playlists/${playlist.id}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
        });
    });

    // ── Error response safety ─────────────────────────────────────────────────

    test.describe("Error responses -- no data leakage", () => {

        test("wrong password response contains no bcrypt hash, stack trace, or ORM internals", async ({ page }) => {
            const res = await page.request.post("/api/auth/login", {
                data: { username: "nonexistentuser_xyz", password: "wrongpassword" },
            });
            expect(res.status()).toBe(401);

            const body = await res.json() as Record<string, unknown>;
            const bodyStr = JSON.stringify(body);
            expect(bodyStr).not.toMatch(/\$2b\$/);               // no bcrypt hash
            expect(bodyStr).not.toMatch(/at Object\.|at Function\./); // no stack trace
            expect(bodyStr).not.toMatch(/prisma|PrismaClient/i); // no ORM internals
        });

        test("validation error after empty playlist name: no playlist created, count unchanged", async ({ page }) => {
            const loginRes = await page.request.post("/api/auth/login", { data: { username, password } });
            expect(loginRes.ok(), "security setup failed: loginRes.ok()").toBeTruthy();
            const { token } = await loginRes.json() as { token: string };

            const beforeRes = await page.request.get("/api/playlists", {
                headers: { Authorization: `Bearer ${token}` },
            });
            const before = await beforeRes.json() as unknown[];
            const beforeCount = Array.isArray(before) ? before.length : 0;

            // Attempt with empty name -- must fail
            const createRes = await page.request.post("/api/playlists", {
                data: { name: "", isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            expect([400, 422]).toContain(createRes.status());

            // Count must not have increased -- parallel tests may delete playlists
            // concurrently, so we only assert the invalid request didn't create anything.
            const afterRes = await page.request.get("/api/playlists", {
                headers: { Authorization: `Bearer ${token}` },
            });
            const after = await afterRes.json() as unknown[];
            const afterCount = Array.isArray(after) ? after.length : 0;
            expect(afterCount).not.toBeGreaterThan(beforeCount);
        });
    });
});
