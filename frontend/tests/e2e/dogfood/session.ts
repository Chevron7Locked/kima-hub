/**
 * Session instrumentation for the dogfood walkthrough.
 *
 * The rest of the E2E suite checks features one at a time: log in, jump straight to a
 * page, assert something, throw the browser away. That finds broken features. It cannot
 * find anything that only goes wrong after a person has been using the app for a while --
 * state that leaks between screens, a listener that gets attached twice, a cache that goes
 * stale, an event stream that quietly reconnects in a loop. Those are the faults that
 * survive a green test suite and greet the user twenty minutes into a real session.
 *
 * So this file runs ONE browser session from login to logout and watches it the whole way
 * through. Two things fall out of that:
 *
 *   1. Faults are attributed. Every error is stamped with the step that was running when it
 *      happened, so a report says "the artwork 404'd while opening the playlist" rather
 *      than "something 404'd".
 *   2. Faults are cumulative. A leak that adds one listener per navigation is invisible in
 *      a test that navigates once, and obvious after thirty client-side navigations.
 */
import { expect, Page, Response } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

export interface Violation {
    /** Which step was executing when this happened. */
    step: string;
    kind: "console" | "pageerror" | "http" | "overflow" | "sse" | "assertion";
    detail: string;
    at: number;
}

/** What a step reports back: the evidence that it did something real. */
export type Observed = Record<string, string | number | boolean | undefined>;

export interface StepRecord {
    name: string;
    journey: string;
    ms: number;
    observed: Observed;
    violations: number;
}

/**
 * Console noise that is not worth failing a deployment over.
 *
 * Keep this list short and specific. Every pattern here is a fault the walkthrough will no
 * longer report, so a loose regex silently buys back the exact coverage this test exists to
 * provide. Anything added here needs a reason next to it.
 */
const IGNORED_CONSOLE = [
    /favicon/i,
    /serviceWorker/i,
    // React DevTools nag, printed once per page load in development builds.
    /Download the React DevTools/i,
    // Next.js prints this for any <img> it would rather have been next/image.
    /Image with src .* has either width or height modified/i,
    // The player saves playback position in the background. Navigating away cancels any
    // save that happens to be in flight, and the browser reports a cancelled fetch as
    // "TypeError: Failed to fetch", which the app's catch block logs. It is the same
    // cancelled-on-navigation case already ignored at the network layer, and it is
    // harmless -- the next save writes the position again a moment later.
    //
    // Narrow on purpose. If the server were genuinely unreachable every other request in
    // the session would fail too, and those are still reported.
    /\[AudioState\] Failed to save to server: TypeError: Failed to fetch/,
];

/** API calls that are allowed to fail, because a step deliberately provokes them. */
export interface ExpectedFailure {
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
    private startedAt = Date.now();
    private heapSamples: Array<{ step: string; mb: number }> = [];
    private notCovered: string[] = [];

    /** The page layout and heap checks run against; swapped when a journey opens another. */
    private activePage: Page;

    constructor(private readonly page: Page, private readonly baseUrl: string) {
        this.activePage = page;
    }

    /**
     * Point the per-step checks at a different page.
     *
     * The phone journey opens its own context, because touch emulation can only be set when
     * a context is created and a narrow desktop window is not a phone. Layout and heap
     * readings have to follow the page the steps are actually driving.
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
        page.on("console", (msg) => {
            if (msg.type() !== "error") return;
            const text = msg.text();
            if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
            // A declared-expected API failure shows up three times: the response itself,
            // the browser's "Failed to load resource", and the app's own logger. Suppress
            // all three together, or declaring one expected failure still fails the run.
            if (this.isExpected(msg.location()?.url ?? "", text)) return;
            this.record("console", text.slice(0, 300));
        });

        // An uncaught exception in page code. React's error boundary may hide the visual
        // result, so the page can look fine while this fires.
        page.on("pageerror", (err) => {
            this.record("pageerror", `${err.name}: ${err.message}`.slice(0, 300));
        });

        page.on("response", (resp: Response) => {
            const url = resp.url();
            if (url.includes("/api/events")) this.sseRequests++;
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

            // ERR_ABORTED means the app cancelled the request itself -- a search-as-you-type
            // box dropping a stale query, or a component unmounting mid-fetch. That is the
            // app being well behaved, and flagging it would fail the run every time someone
            // types. A request that genuinely could not be served fails differently
            // (connection refused, name not resolved, timed out).
            if (reason.includes("ERR_ABORTED")) return;

            this.record("http", `FAILED ${req.method()} ${url.replace(this.baseUrl, "")} -- ${reason}`);
        });
    }

    /** Allow a specific API failure for the duration of one step. */
    expectFailure(f: ExpectedFailure): void {
        this.expectedFailures.push(f);
    }

    /**
     * Has this failure been declared as expected?
     *
     * `haystack` is the URL for a response, or the console text for a log line -- the app's
     * own logger prints the path without the origin, so both are matched against the
     * pattern. The status has to appear too, so declaring "404 on this route is fine" does
     * not quietly excuse a 500 on the same route.
     */
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
            step: this.currentStep,
            kind,
            detail,
            at: Date.now() - this.startedAt,
        });
    }

    setJourney(name: string): void {
        this.currentJourney = name;
    }

    /**
     * Record something this run could NOT check, and why.
     *
     * The preflight knows some gaps before the run starts. Others only surface once the
     * run is under way -- a podcast directory that is down, an Audiobookshelf with nothing
     * in it. Both kinds belong in the same list, because the danger is identical: an
     * unexercised journey silently reading as a passing one.
     */
    noteNotCovered(reason: string): void {
        this.notCovered.push(reason);
    }

    /** Everything this run could not exercise, discovered before or during it. */
    get gaps(): string[] {
        return [...this.notCovered];
    }

    /**
     * Run one interaction and record what it saw.
     *
     * The callback returns whatever the step observed -- a track count, a stream URL, a
     * playlist id. Those values become the evidence in the report: they are how a reader
     * tells "the page rendered" from "the page rendered the user's actual music".
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
            this.record("assertion", String(err).slice(0, 400));
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
        const overflow = await this.activePage.evaluate(() => {
            const doc = document.documentElement;
            return { scroll: doc.scrollWidth, client: doc.clientWidth };
        });
        if (overflow.scroll > overflow.client + 1) {
            this.record(
                "overflow",
                `page scrolls sideways: content ${overflow.scroll}px in a ${overflow.client}px viewport`,
            );
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
        const fresh = this.violations.filter((v) => !v.detail.startsWith("[reported]"));
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

    get heapGrowthMb(): number {
        if (this.heapSamples.length < 2) return -1;
        return this.heapSamples[this.heapSamples.length - 1].mb - this.heapSamples[0].mb;
    }

    /**
     * Write the evidence trail. This is what makes the walkthrough a deployment gate rather
     * than just a test: a reader who was not watching it run can see which journeys ran,
     * what data each step actually saw, and what went wrong where.
     */
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
 * Navigate by clicking, the way a person does.
 *
 * page.goto() does a full browser reload, which throws away every piece of React state --
 * the queue, the current track, open panels. Half the value of a continuous walkthrough is
 * that state carries across screens, so the walkthrough clicks links instead. If the link
 * is not on screen this throws rather than silently falling back to a reload, because a
 * fallback would quietly convert this test back into the isolated kind.
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
 * The first album card in the main content area.
 *
 * Scoped to <main> deliberately. A bare `a[href^="/album/"]` also matches the 56px artwork
 * thumbnails in the sidebar's recently-played strip, which sit in the bottom-left corner --
 * underneath the Next.js dev-tools overlay, which swallows the click. Beyond dodging that,
 * the album grid is what a person actually clicks, so scoping here makes the walkthrough
 * more faithful rather than less.
 */
export function firstAlbumCard(page: Page) {
    return page.locator('main a[href^="/album/"]').first();
}

/**
 * Open the Collection screen on its Albums tab.
 *
 * Collection opens on Artists, so anything looking for album cards has to switch tabs
 * first. The switch goes through the tab button rather than a URL, both because that is
 * what a person does and because the page keeps tab state in the URL via a client-side
 * push -- navigating directly would reload and throw away the session state the
 * walkthrough exists to carry forward.
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

/**
 * Wait for the app to settle.
 *
 * networkidle is unusable here: the app holds a server-sent-events stream open for live
 * updates, so the network is never idle and the wait times out. Settle on the DOM instead,
 * then give React a moment to paint the data it fetched.
 */
export async function settle(page: Page, ms = 800): Promise<void> {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(ms);
}
