import { describe, it, expect, vi, afterEach } from "vitest";
import { flushMicrotasks, newController } from "./helpers/audioControllerEnv";

afterEach(() => {
    vi.unstubAllGlobals();
});

/**
 * A browser reaching the end of a file fires "pause" and then "ended". The pause is part of ending, not a pause:
 * the app's "ended" handler (which saves a podcast or audiobook as finished) must run before anything hears
 * "paused", or a not-finished save goes out first and can land last.
 */
describe("AudioController -- the end of a file", () => {
    it("announces the end before any listener sees it paused", async () => {
        const { controller, audio } = newController();
        const heard: string[] = [];
        controller.subscribe((snap) => heard.push(`status:${snap.status}`));
        controller.on("ended", () => heard.push("ended"));

        controller.load("http://x.com/episode.mp3", { autoplay: true });
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();
        expect(controller.getSnapshot().status).toBe("playing");
        heard.length = 0;

        // What the element does at the end: paused and ended both true, then "pause", then "ended".
        audio.currentTime = 120;
        audio.paused = true;
        audio.ended = true;
        audio.__fire("pause");
        audio.__fire("ended");

        expect(heard.indexOf("ended")).toBeGreaterThanOrEqual(0);
        const firstPaused = heard.indexOf("status:paused");
        expect(firstPaused === -1 || firstPaused > heard.indexOf("ended")).toBe(true);
    });

    it("still treats a pause before the end as a pause", async () => {
        const { controller, audio } = newController();
        controller.load("http://x.com/episode.mp3", { autoplay: true });
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();

        audio.currentTime = 40;
        audio.paused = true;
        audio.__fire("pause");

        expect(controller.getSnapshot().status).toBe("paused");
    });

    it("knows it ended, and a pause asked for after the end does not swallow the next real pause", async () => {
        const { controller, audio } = newController();
        controller.load("http://x.com/a.mp3", { autoplay: true });
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();

        audio.currentTime = 120;
        audio.paused = true;
        audio.ended = true;
        audio.__fire("pause");
        audio.__fire("ended");
        expect(controller.hasEnded()).toBe(true);
        // The app pauses at the end of a show; the element is already paused and fires nothing.
        controller.pause();

        controller.load("http://x.com/b.mp3", { autoplay: true });
        audio.ended = false;
        audio.duration = 120;
        audio.__fire("canplay");
        audio.paused = false;
        audio.__fire("playing");
        await flushMicrotasks();
        expect(controller.hasEnded()).toBe(false);

        // An earbud pause mid-file.
        audio.currentTime = 30;
        audio.paused = true;
        audio.__fire("pause");
        expect(controller.getSnapshot().status).toBe("paused");
    });
});
