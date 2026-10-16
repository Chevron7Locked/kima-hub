/**
 * The walkthrough's last journey requires the event stream never to reconnect; that only means something if the
 * counter it reads counts a real reconnect. Here the page's stream fails as a dropped connection does, the app opens
 * a new one on its own, and the count must rise; signing out and back in on the same page must not count.
 */
import { test, expect } from "@playwright/test";
import { DogfoodSession } from "./session";
import { settle } from "../fixtures/shared";

const baseUrl = process.env.KIMA_UI_BASE_URL || "http://127.0.0.1:3030";
const username = process.env.KIMA_TEST_USERNAME || "";
const password = process.env.KIMA_TEST_PASSWORD || "";

test("the session counts a dropped event stream reconnecting, and not a sign-out and back in", async ({ browser }) => {
    expect(username && password, "KIMA_TEST_USERNAME and KIMA_TEST_PASSWORD must be set").toBeTruthy();
    const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 900 } });
    // Keep every event stream the app opens reachable, so this test can fail one the way a dropped connection does.
    await context.addInitScript(() => {
        const Original = window.EventSource;
        const opened: EventSource[] = [];
        (window as unknown as { __streams: EventSource[] }).__streams = opened;
        window.EventSource = class extends Original {
            constructor(url: string | URL, init?: EventSourceInit) {
                super(url, init);
                opened.push(this);
            }
        };
    });
    const page = await context.newPage();
    const session = new DogfoodSession(page, baseUrl);
    session.attach();

    /** Signs in on the login screen; `fresh` loads it first, otherwise it is the one the app is already showing. */
    const signIn = async (fresh: boolean) => {
        session.expectFailure({ urlPattern: /\/api\//, status: 401, reason: "the session check on the login screen" });
        if (fresh) await page.goto("/login");
        await settle(page);
        await page.locator("#username").fill(username);
        await page.locator("#password").fill(password);
        await page.getByRole("button", { name: "Sign In" }).click();
        await page.waitForURL(/\/($|\?|home)/, { timeout: 20_000 });
        session.clearExpectedFailures();
    };

    try {
        await signIn(true);
        await expect.poll(() => session.sseConnectionCount, { message: "the event stream never opened", timeout: 20_000 }).toBeGreaterThanOrEqual(1);
        const opensBefore = session.sseConnectionCount;
        expect(session.sseReopenCount).toBe(0);

        // The connection drops: the stream closes and reports an error, as the browser does; the app reopens it.
        await page.evaluate(() => {
            const streams = (window as unknown as { __streams: EventSource[] }).__streams;
            const stream = streams[streams.length - 1];
            stream.close();
            stream.onerror?.(new Event("error"));
        });
        await expect.poll(() => session.sseReopenCount, { message: "a dropped stream reconnecting was not counted", timeout: 20_000 }).toBe(1);
        expect(session.sseConnectionCount).toBe(opensBefore + 1);

        // Signing out closes the stream on purpose; signing back in on the login screen the app moved to (the same
        // page, when the app moves there itself) opens a new one, which is not a reconnect.
        session.expectFailure({ urlPattern: /\/api\//, status: 401, reason: "requests in flight when the session ended" });
        await page.goto("/settings");
        await expect.poll(() => session.sseConnectionCount, { message: "the stream did not open on the settings page", timeout: 20_000 }).toBe(opensBefore + 2);
        await settle(page, 1500);
        await page.getByRole("button", { name: "Logout", exact: true }).click({ timeout: 10_000 });
        await page.waitForURL(/login/, { timeout: 20_000 });
        const opensBeforeSignIn = session.sseConnectionCount;
        await signIn(false);
        await expect.poll(() => session.sseConnectionCount, { message: "the stream did not open after signing back in", timeout: 20_000 }).toBe(opensBeforeSignIn + 1);
        expect(session.sseReopenCount, "signing out and back in was counted as a reconnect").toBe(1);
    } finally {
        await context.close();
    }
});
