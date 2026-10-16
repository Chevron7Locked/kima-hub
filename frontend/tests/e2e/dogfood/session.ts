/**
 * One browser session from login to logout, watched the whole way. Every fault is
 * stamped with the step that was running, and faults that build up over many
 * navigations (leaked listeners, reconnect loops) become visible.
 */
import { expect, Page, Response } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { settle } from "../fixtures/shared";

interface Violation {
    /** Which journey and step were executing when this happened. */
    journey: string;
    step: string;
    kind: "console" | "pageerror" | "http" | "overflow" | "sse" | "assertion";
    detail: string;
    at: number;
}

/** What a step reports back: the evidence that it did something real. */
type Observed = Record<string, string | number | boolean | undefined>;

interface StepRecord {
    name: string;
    journey: string;
    ms: number;
    observed: Observed;
    violations: number;
}

/**
 * Console noise that is not worth failing a deployment over. Keep it short and
 * specific: a loose pattern stops the walkthrough reporting real faults, so each
 * one carries its reason.
 */
const IGNORED_CONSOLE = [
    // React DevTools nag, printed once per page load in development builds.
    /Download the React DevTools/i,
    // Next.js prints this for any <img> it would rather have been next/image.
    /Image with src .* has either width or height modified/i,
    // Headless Chromium + SwiftShader cannot importScripts inside blob: workers;
    // deck.gl falls back to the main thread and the map still renders.
    /Failed to execute 'importScripts' on 'WorkerGlobalScope'/,
    /worker module init function failed to rehydrate/,
];

/** API calls that are allowed to fail, because a step deliberately provokes them. */
interface ExpectedFailure {
    urlPattern: RegExp;
    status: number;
    reason: string;
}

export class DogfoodSession {
    readonly violations: Violation[] = [];
    readonly steps: StepRecord[] = [];
    private currentStep = "<before first step>";
    private currentJourney = "<none>";
    private expectedFailures: ExpectedFailure[] = [];
    private sseRequests = 0;
    private sseReopens = 0;
    private startedAt = Date.now();
    private heapSamples: Array<{ step: string; mb: number }> = [];
    private notCovered: string[] = [];

    /** The page layout and heap checks run against; swapped when a journey opens another. */
    private activePage: Page;

    constructor(private readonly page: Page, private readonly baseUrl: string) {
        this.activePage = page;
    }

    /**
     * Points the per-step layout and heap checks at another page. The phone journey
     * opens its own context, because touch emulation is set only when a context is created.
     */
    setActivePage(target: Page): void {
        this.activePage = target;
    }

    /**
     * Start watching. Call this BEFORE navigating anywhere, so the login page itself is
     * covered -- a crash on the first paint is still a crash.
     */
    attach(target?: Page): void {
        const page = target ?? this.page;
        // Streams opened by the page now showing: a new page document (a navigation request in the main frame,
        // before any of its scripts run) or a sign-out (which closes the stream on purpose) starts the count again.
        // A second stream within one signed-in page is a reconnect.
        let streamsThisPage = 0;
        page.on("request", (req) => {
            if (req.isNavigationRequest() && req.frame() === page.mainFrame()) streamsThisPage = 0;
            else if (new URL(req.url()).pathname === "/api/auth/logout") streamsThisPage = 0;
        });
        page.on("console", (msg) => {
            if (msg.type() !== "error") return;
            const text = msg.text();
            if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
            // A declared-expected API failure shows up three times: the response itself,
            // the browser's "Failed to load resource", and the app's own logger. Suppress
            // all three together, or declaring one expected failure still fails the run.
            if (this.isExpected(msg.location()?.url ?? "", text)) return;
            const loc = msg.location();
            const url = loc?.url ? ` at ${loc.url}` : "";
            this.record("console", `${text.slice(0, 300)}${url}`);
        });

        // An uncaught exception in page code. React's error boundary may hide the visual
        // result, so the page can look fine while this fires.
        page.on("pageerror", (err) => {
            // The blob-worker failure from IGNORED_CONSOLE, surfaced as an uncaught error.
            if (/Worker module function was called but .init. did not return a callable function/.test(err.message)) return;
            this.record("pageerror", `${err.name}: ${err.message}`.slice(0, 300));
        });

        page.on("response", (resp: Response) => {
            const url = resp.url();
            // The stream itself (GET /api/events?ticket=…), not the ticket request that precedes it.
            if (new URL(url).pathname === "/api/events") {
                this.sseRequests++;
                if (streamsThisPage++ > 0) this.sseReopens++;
            }
            if (!url.includes("/api/")) return;

            const status = resp.status();
            if (status < 400) return;

            const short = url.replace(this.baseUrl, "");
            if (this.isExpected(url, String(status))) return;

            this.record("http", `${status} ${resp.request().method()} ${short}`);
        });

        page.on("requestfailed", (req) => {
            const url = req.url();
            if (!url.includes("/api/")) return;
            // An SSE stream is expected to be torn down on navigation.
            if (url.includes("/api/events")) return;

            const reason = req.failure()?.errorText ?? "unknown";

            // ERR_ABORTED is the app cancelling its own request (a stale search, an
            // unmount). A request that could not be served fails differently.
            if (reason.includes("ERR_ABORTED")) return;

            this.record("http", `FAILED ${req.method()} ${url.replace(this.baseUrl, "")} -- ${reason}`);
        });
    }

    /** Allow a specific API failure for the duration of one step. */
    expectFailure(f: ExpectedFailure): void {
        this.expectedFailures.push(f);
    }

    /** Whether a failure was declared expected. The status must match too, so an allowed 404 never excuses a 500. */
    private isExpected(url: string, textOrStatus: string): boolean {
        return this.expectedFailures.some(
            (e) =>
                (e.urlPattern.test(url) || e.urlPattern.test(textOrStatus)) &&
                textOrStatus.includes(String(e.status)),
        );
    }

    clearExpectedFailures(): void {
        this.expectedFailures = [];
    }

    private record(kind: Violation["kind"], detail: string): void {
        this.violations.push({
            journey: this.currentJourney,
            step: this.currentStep,
            kind,
            detail,
            at: Date.now() - this.startedAt,
        });
    }

    setJourney(name: string): void {
        this.currentJourney = name;
        this.currentStep = "<between steps>";
    }

    /**
     * Records something this run could not check, and why, so an unexercised
     * journey never reads as a passing one.
     */
    noteNotCovered(reason: string): void {
        this.notCovered.push(reason);
    }

    /** Everything this run could not exercise, discovered before or during it. */
    get gaps(): string[] {
        return [...this.notCovered];
    }

    /**
     * Runs one interaction. The callback returns what the step observed (a track count,
     * a stream URL, a playlist id); the report shows it, so a reader can tell "the page
     * rendered" from "the page rendered the user's actual music".
     */
    async step(name: string, fn: () => Promise<Observed | void>): Promise<void> {
        this.currentStep = name;
        const before = this.violations.length;
        const t0 = Date.now();

        let observed: Observed = {};
        try {
            const result = await fn();
            if (result) observed = result;
        } catch (err) {
            // test.skip() inside a step throws; it must propagate so the runner marks
            // the journey skipped, but the gap is already captured via noteNotCovered --
            // recording it here would fail the run for a deliberate, disclosed skip.
            const deliberate = String(err).startsWith("Test is skipped") || String(err).startsWith("Error: Test is skipped");
            if (!deliberate) this.record("assertion", String(err).slice(0, 400));
            this.steps.push({
                name,
                journey: this.currentJourney,
                ms: Date.now() - t0,
                observed,
                violations: this.violations.length - before,
            });
            throw err;
        }

        await this.checkLayout();
        await this.sampleHeap(name);

        this.steps.push({
            name,
            journey: this.currentJourney,
            ms: Date.now() - t0,
            observed,
            violations: this.violations.length - before,
        });
    }

    /**
     * The page must never scroll sideways. A horizontal scrollbar means something spilled
     * out of its container, which on a phone is the difference between a usable screen and
     * a broken one. One pixel of tolerance covers sub-pixel rounding in the layout engine.
     */
    private async checkLayout(): Promise<void> {
        // The app shell scrolls inside #main-content, so the document alone never overflows.
        const overflow = await this.activePage.evaluate(() => {
            const els = [document.documentElement, document.querySelector("#main-content")].filter(
                (el): el is HTMLElement => !!el,
            );
            const worst = els.reduce((a, b) => (b.scrollWidth - b.clientWidth > a.scrollWidth - a.clientWidth ? b : a));
            return { scroll: worst.scrollWidth, client: worst.clientWidth };
        });
        if (overflow.scroll > overflow.client + 1) {
            this.record(
                "overflow",
                `page scrolls sideways: content ${overflow.scroll}px in a ${overflow.client}px viewport`,
            );
        }
        // The page area must end inside the window: one that grows to its content's
        // height never overflows itself, so nothing on the page can scroll.
        const runsPast = await this.activePage.evaluate(() => {
            const main = document.querySelector("#main-content");
            return main ? Math.round(main.getBoundingClientRect().bottom - window.innerHeight) : 0;
        });
        if (runsPast > 1) {
            this.record("overflow", `the page area runs ${runsPast}px past the bottom of the window, so it cannot scroll`);
        }
    }

    /** Chrome-only heap reading. Advisory: recorded for the report, never fails a step. */
    private async sampleHeap(step: string): Promise<void> {
        const mb = await this.activePage.evaluate(() => {
            const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
            return perf.memory ? Math.round(perf.memory.usedJSHeapSize / 1048576) : -1;
        });
        if (mb >= 0) this.heapSamples.push({ step, mb });
    }

    /**
     * Assert the session is still clean. Called at the end of each journey so a failure
     * names the journey that caused it rather than surfacing at teardown with no context.
     */
    assertClean(journey: string): void {
        // Everything that happened during this journey, inside a step or between steps. An earlier journey
        // that threw before its own check keeps its problems to itself.
        const fresh = this.violations.filter((v) => !v.detail.startsWith("[reported]") && v.journey === this.currentJourney);
        if (fresh.length === 0) return;

        const summary = fresh
            .map((v) => `  [${v.kind}] during "${v.step}": ${v.detail}`)
            .join("\n");
        // Mark as reported so the next journey does not fail for the same violations.
        fresh.forEach((v) => (v.detail = `[reported] ${v.detail}`));
        expect(fresh, `${journey} produced ${fresh.length} violation(s):\n${summary}`).toHaveLength(0);
    }

    /** How many times the event stream was (re)opened. */
    get sseConnectionCount(): number {
        return this.sseRequests;
    }

    /** How many times a page opened the event stream again after its first: each is a dropped stream reconnecting. */
    get sseReopenCount(): number {
        return this.sseReopens;
    }

    get heapGrowthMb(): number {
        if (this.heapSamples.length < 2) return -1;
        return this.heapSamples[this.heapSamples.length - 1].mb - this.heapSamples[0].mb;
    }

    /** Writes the evidence trail: which journeys ran, what each step saw, and what went wrong where. */
    writeReport(outDir: string): string {
        fs.mkdirSync(outDir, { recursive: true });

        const clean = this.violations.map((v) => ({
            ...v,
            detail: v.detail.replace(/^\[reported\] /, ""),
        }));

        const json = {
            baseUrl: this.baseUrl,
            durationMs: Date.now() - this.startedAt,
            steps: this.steps,
            violations: clean,
            notCovered: this.notCovered,
            sseConnections: this.sseRequests,
            heapSamples: this.heapSamples,
            heapGrowthMb: this.heapGrowthMb,
        };
        fs.writeFileSync(path.join(outDir, "dogfood-report.json"), JSON.stringify(json, null, 2));

        const lines: string[] = [];
        lines.push(`# Dogfood walkthrough`);
        lines.push("");
        lines.push(`Ran against ${this.baseUrl} in ${Math.round(json.durationMs / 1000)}s.`);
        lines.push("");

        if (clean.length === 0) {
            lines.push(`No violations. ${this.steps.length} steps completed.`);
        } else {
            lines.push(`**${clean.length} violation(s) across ${this.steps.length} steps.**`);
            lines.push("");
            for (const v of clean) {
                lines.push(`- \`${v.kind}\` during **${v.step}** — ${v.detail}`);
            }
        }
        lines.push("");
        lines.push(`## What each step saw`);
        lines.push("");

        let journey = "";
        for (const s of this.steps) {
            if (s.journey !== journey) {
                journey = s.journey;
                lines.push("");
                lines.push(`### ${journey}`);
                lines.push("");
            }
            const obs = Object.entries(s.observed)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ");
            const flag = s.violations > 0 ? ` ⚠️ ${s.violations}` : "";
            lines.push(`- ${s.name} — ${s.ms}ms${obs ? ` — ${obs}` : ""}${flag}`);
        }

        if (this.notCovered.length > 0) {
            lines.push("");
            lines.push(`## Not covered by this run`);
            lines.push("");
            for (const r of this.notCovered) lines.push(`- ${r}`);
        }

        lines.push("");
        lines.push(`## Session health`);
        lines.push("");
        lines.push(`- Event stream opened ${this.sseRequests} time(s)`);
        if (this.heapGrowthMb >= 0) {
            lines.push(`- JS heap grew ${this.heapGrowthMb}MB across the session`);
        }

        const md = lines.join("\n");
        const mdPath = path.join(outDir, "dogfood-report.md");
        fs.writeFileSync(mdPath, md);
        return mdPath;
    }
}

/**
 * Navigates by clicking a link so React state carries across screens. Throws
 * when the link is not on screen rather than falling back to a reload.
 */
export async function navigateByClick(page: Page, href: string, timeoutMs = 10_000): Promise<void> {
    const link = page.locator(`a[href="${href}"]`).first();
    await link.waitFor({ state: "visible", timeout: timeoutMs });
    await link.click();
    await page.waitForURL((url) => url.pathname === href || url.pathname.startsWith(href), {
        timeout: timeoutMs,
    });
    await page.waitForLoadState("domcontentloaded");
}

/**
 * The first album card in <main>. The sidebar's recently-played thumbnails also
 * link to albums and sit under the Next.js dev overlay.
 */
export function firstAlbumCard(page: Page) {
    return page.locator('main a[href^="/album/"]').first();
}

/**
 * An album page's rows for songs the library has. A song the album should have but the library
 * lacks is a preview-only row with no queue or playlist buttons.
 */
export function playableRows(page: Page) {
    return page.locator("[data-track-row]").filter({ has: page.getByLabel("Add to queue") });
}

/**
 * From the albums page, opens the first album with at least `min` songs the library has. One-song
 * albums are ordinary in a real library, so a journey that needs several rows has to choose one.
 * Only the page on screen is searched; an album that never shows a playable row counts as too short.
 */
export async function openAlbumWithSongs(page: Page, min: number, timeoutMs = 12_000): Promise<void> {
    const cards = page.locator('main a[href^="/album/"]');
    await cards.first().waitFor({ state: "visible", timeout: timeoutMs });
    const hrefs = [...new Set(await cards.evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? "")))];
    for (const href of hrefs) {
        await page.locator(`main a[href="${href}"]`).first().click();
        await page.waitForURL(/\/album\//, { timeout: 10_000 });
        const rows = playableRows(page);
        const shown = await rows.first().waitFor({ state: "visible", timeout: timeoutMs }).then(() => true, () => false);
        if (shown) {
            await settle(page, 1200);
            if ((await rows.count()) >= min) return;
        }
        await page.goBack();
        await cards.first().waitFor({ state: "visible", timeout: timeoutMs });
    }
    throw new Error(`no album on this albums page has ${min} or more songs the library can play`);
}

/**
 * Opens Collection on its Albums tab through the tab button; a URL navigation
 * would reload and lose the session state.
 */
export async function openAlbumsTab(page: Page, timeoutMs = 15_000): Promise<void> {
    if (!page.url().includes("/collection")) {
        await navigateByClick(page, "/collection", timeoutMs);
    }
    const albumsTab = page.getByRole("button", { name: "Albums", exact: true });
    await albumsTab.waitFor({ state: "visible", timeout: timeoutMs });
    await albumsTab.click();
    await page.waitForURL(/tab=albums/, { timeout: timeoutMs });
    await firstAlbumCard(page).waitFor({ state: "visible", timeout: timeoutMs });
}
