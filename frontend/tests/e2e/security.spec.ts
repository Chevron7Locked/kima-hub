import { test, expect } from "@playwright/test";
import { username, password } from "./fixtures/test-helpers";

/**
 * Security E2E Tests
 *
 * These run against the full Docker stack (real DB, real Redis, real JWT).
 * They complement the backend unit tests, which verify individual middleware
 * and route logic in isolation. These tests verify the whole system works
 * correctly end-to-end under security scenarios.
 *
 * Scope:
 *   - IDOR: two real users, real playlists, real ownership enforcement
 *   - XSS: real browser rendering of attacker-controlled data
 *   - Mass assignment: real API rejects injected fields
 *   - Error responses: no data leakage in real server responses
 *
 * Not in scope here (covered by backend unit tests):
 *   - Auth middleware behavior (tokenVersion, expired JWT, missing header)
 *   - Route-level ownership logic (covered by playlists.route.test.ts)
 */

async function apiLogin(
    page: Parameters<typeof test>[1] extends (args: infer A) => unknown ? never : never,
    // Use page.request directly from test fixture instead
    req: { post: (url: string, options?: Record<string, unknown>) => Promise<{ ok: () => boolean; json: () => Promise<unknown> }> },
    u: string,
    p: string,
): Promise<string> {
    const res = await req.post("/api/auth/login", { data: { username: u, password: p } });
    if (!res.ok()) throw new Error(`Login failed as ${u}`);
    return ((await res.json()) as { token: string }).token;
}

const ATTACKER_USER = `attacker_${Date.now()}`;
const ATTACKER_PASS = "AttackerPass123!";

test.describe("Security", () => {

    // ── IDOR ─────────────────────────────────────────────────────────────────

    test.describe("IDOR -- cross-user isolation", () => {

        test.beforeAll(async ({ request }) => {
            // Create attacker account using the admin test user's credentials.
            // If the test user lacks admin role, subsequent tests will skip gracefully.
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
                // Non-fatal: individual tests skip if attacker login fails
            }
        });

        test("attacker cannot READ victim's private playlist -- must be 403 not 404", async ({ page }) => {
            // Login as victim (the admin test user) and create a private playlist
            const victimToken = await page.request.post("/api/auth/login", {
                data: { username, password },
            }).then(r => r.json()).then((b: { token: string }) => b.token);

            if (!victimToken) { test.skip(); return; }

            const createRes = await page.request.post("/api/playlists", {
                data: { name: `victim-private-${Date.now()}`, isPublic: false },
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const { id: playlistId } = await createRes.json() as { id: string };

            // Login as attacker
            const attackerLoginRes = await page.request.post("/api/auth/login", {
                data: { username: ATTACKER_USER, password: ATTACKER_PASS },
            });
            if (!attackerLoginRes.ok()) { test.skip(); return; }
            const { token: attackerToken } = await attackerLoginRes.json() as { token: string };

            // Attacker attempts to read victim's private playlist
            const readRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${attackerToken}` },
            });

            // Must be 403 (access denied), not 404 (which hides that the resource exists
            // and would mask a broken ownership check that silently falls through to not found)
            expect(readRes.status()).toBe(403);

            // Cleanup
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
        });

        test("attacker cannot UPDATE victim's playlist -- name must be unchanged in DB after attempt", async ({ page }) => {
            const victimToken = await page.request.post("/api/auth/login", {
                data: { username, password },
            }).then(r => r.json()).then((b: { token: string }) => b.token);
            if (!victimToken) { test.skip(); return; }

            const originalName = `victim-update-${Date.now()}`;
            const createRes = await page.request.post("/api/playlists", {
                data: { name: originalName, isPublic: false },
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const { id: playlistId } = await createRes.json() as { id: string };

            const attackerLoginRes = await page.request.post("/api/auth/login", {
                data: { username: ATTACKER_USER, password: ATTACKER_PASS },
            });
            if (!attackerLoginRes.ok()) { test.skip(); return; }
            const { token: attackerToken } = await attackerLoginRes.json() as { token: string };

            // Attacker attempts rename
            const updateRes = await page.request.put(`/api/playlists/${playlistId}`, {
                data: { name: "HIJACKED" },
                headers: { Authorization: `Bearer ${attackerToken}` },
            });
            expect(updateRes.status()).toBe(403);

            // Verify the name was NOT changed -- re-fetch as victim
            const verifyRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            expect(verifyRes.status()).toBe(200);
            const verified = await verifyRes.json() as { name: string };
            expect(verified.name).toBe(originalName); // unchanged

            // Cleanup
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
        });

        test("attacker cannot DELETE victim's playlist -- resource must still exist after attempt", async ({ page }) => {
            const victimToken = await page.request.post("/api/auth/login", {
                data: { username, password },
            }).then(r => r.json()).then((b: { token: string }) => b.token);
            if (!victimToken) { test.skip(); return; }

            const createRes = await page.request.post("/api/playlists", {
                data: { name: `victim-delete-${Date.now()}`, isPublic: false },
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const { id: playlistId } = await createRes.json() as { id: string };

            const attackerLoginRes = await page.request.post("/api/auth/login", {
                data: { username: ATTACKER_USER, password: ATTACKER_PASS },
            });
            if (!attackerLoginRes.ok()) { test.skip(); return; }
            const { token: attackerToken } = await attackerLoginRes.json() as { token: string };

            // Attacker attempts deletion
            const deleteRes = await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${attackerToken}` },
            });
            expect(deleteRes.status()).toBe(403);

            // Verify the playlist still exists -- victim can still access it
            const verifyRes = await page.request.get(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
            expect(verifyRes.status()).toBe(200);

            // Cleanup
            await page.request.delete(`/api/playlists/${playlistId}`, {
                headers: { Authorization: `Bearer ${victimToken}` },
            });
        });
    });

    // ── XSS ──────────────────────────────────────────────────────────────────

    test.describe("XSS -- stored payload rendering", () => {

        test("script tag in playlist name does not execute in browser", async ({ page }) => {
            const loginRes = await page.request.post("/api/auth/login", { data: { username, password } });
            if (!loginRes.ok()) { test.skip(); return; }
            const { token } = await loginRes.json() as { token: string };

            const payload = `<script>window.__xss_script=true</script>xss-${Date.now()}`;
            const createRes = await page.request.post("/api/playlists", {
                data: { name: payload, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
            const { id: playlistId } = await createRes.json() as { id: string };

            // Navigate in browser and verify the script did not execute
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
            if (!loginRes.ok()) { test.skip(); return; }
            const { token } = await loginRes.json() as { token: string };

            const payload = `<img src=x onerror="window.__xss_onerror=true">xss-${Date.now()}`;
            const createRes = await page.request.post("/api/playlists", {
                data: { name: payload, isPublic: false },
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!createRes.ok()) { test.skip(); return; }
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
            if (!loginRes.ok()) { test.skip(); return; }
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
            if (!res.ok()) { test.skip(); return; }
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
            if (!loginRes.ok()) { test.skip(); return; }
            const { token } = await loginRes.json() as { token: string };

            // Capture count before
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

            // Count must be unchanged
            const afterRes = await page.request.get("/api/playlists", {
                headers: { Authorization: `Bearer ${token}` },
            });
            const after = await afterRes.json() as unknown[];
            const afterCount = Array.isArray(after) ? after.length : 0;
            expect(afterCount).toBe(beforeCount);
        });
    });
});
