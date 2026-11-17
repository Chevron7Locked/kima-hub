/** Constants and helpers every spec can import; nothing here reads the environment. */
import type { BrowserContext, Page } from "@playwright/test";

/** CSS selector for the main audio element. */
export const PLAYER = '[data-kima-player="main"]';

export interface PlayerState {
    t: number;
    paused: boolean;
    ready: number;
    src: string;
}

/** Position, pause state, readyState and source of an audio element; t is -1 and src is empty when it is absent. */
export function readPlayer(page: Page, selector: string = PLAYER): Promise<PlayerState> {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLAudioElement | null;
        return {
            t: el?.currentTime ?? -1,
            paused: el?.paused ?? true,
            ready: el?.readyState ?? 0,
            src: el?.src ?? "",
        };
    }, selector);
}

/**
 * Records who paused each Kima audio element: the page calling pause(), a media-session pause (headphones or a
 * media key, which Kima then carries out itself), or something outside the page that never told it (the OS).
 */
export function watchPauses(context: BrowserContext): Promise<void> {
    return context.addInitScript(() => {
        const win = window as unknown as { __kimaPauses: string[] };
        win.__kimaPauses = [];
        const log = (line: string) => win.__kimaPauses.push(`${(performance.now() / 1000).toFixed(1)}s ${line}`);
        const calledByPage = new WeakSet<HTMLMediaElement>();
        const originalPause = HTMLMediaElement.prototype.pause;
        HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
            // Only pause() on a playing element fires "pause"; load() and src changes pause without one.
            if (!this.paused) calledByPage.add(this);
            return originalPause.call(this);
        };
        if ("mediaSession" in navigator) {
            const originalSet = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
            navigator.mediaSession.setActionHandler = (action, handler) =>
                originalSet(
                    action,
                    handler && action === "pause"
                        ? (details) => {
                              log("media-session pause (headphones or a media key)");
                              handler(details);
                          }
                        : handler,
                );
        }
        document.addEventListener("play", (e) => calledByPage.delete(e.target as HTMLMediaElement), true);
        document.addEventListener(
            "pause",
            (e) => {
                const el = e.target as HTMLMediaElement;
                const pageAsked = calledByPage.delete(el);
                if (!el.dataset?.kimaPlayer || el.ended) return;
                const cause = pageAsked ? "by the page" : "from outside the page (the OS or browser)";
                log(`${el.dataset.kimaPlayer} player paused ${cause} at ${el.currentTime.toFixed(2)}s`);
            },
            true,
        );
    });
}

/** The pauses watchPauses saw, for a failure message; empty when it was not installed. */
export async function pausesSeen(page: Page): Promise<string> {
    const seen = await page
        .evaluate(() => (window as unknown as { __kimaPauses?: string[] }).__kimaPauses ?? [])
        .catch(() => []);
    return seen.length ? ` (last pauses, page time: ${seen.slice(-3).join("; ")})` : "";
}

/** Makes a literal string safe inside a RegExp used as an accessible-name filter. */
export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Headless Chromium has no WebGL and the vibe map needs it; these flags turn on software rendering. */
export const softwareWebGL = {
    launchOptions: {
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
};

/**
 * Waits for the app to settle. networkidle never fires because the app holds a
 * server-sent-events stream open, so this waits for the DOM and then lets React paint.
 */
export async function settle(page: Page, ms = 800): Promise<void> {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(ms);
}
