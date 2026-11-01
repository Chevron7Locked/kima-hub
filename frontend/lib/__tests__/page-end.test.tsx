/**
 * The room under a page's last row belongs to the layout, not to each page. On a desktop the player is a bar below
 * the content, so the room is one section beat; on a phone the mini player floats over the content, so while it shows
 * it marks the page and the room grows to clear it. Pages end with `.page-end`, never their own bottom padding.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const media = vi.hoisted(() => ({ hasMedia: true }));
vi.mock("@/hooks/usePlayerControls", () => ({
    usePlayerControls: () => ({
        currentTrack: media.hasMedia ? { id: "t1" } : null,
        currentAudiobook: null,
        currentPodcast: null,
        playbackType: "track",
        isPlaying: false,
        isBuffering: false,
        audioError: null,
        progress: 0,
        pause: () => {},
        resumeWithGesture: () => {},
        openOverlay: () => {},
    }),
}));
vi.mock("@/hooks/useMediaInfo", () => ({
    useMediaInfo: () => ({ title: "t", subtitle: "s", coverUrl: null, hasMedia: media.hasMedia }),
}));
vi.mock("@/components/ui/CachedImage", () => ({ CachedImage: () => null }));
vi.mock("@/components/player/VibeToggleButton", () => ({ VibeToggleButton: () => null }));
vi.mock("@/components/player/PlayPauseButton", () => ({ PlayPauseButton: () => null }));

import { MiniPlayer } from "@/components/player/MiniPlayer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.documentElement.removeAttribute("data-mini-player");
});

const marked = () => document.documentElement.hasAttribute("data-mini-player");

describe("the mini player marks the page while it covers it", () => {
    it("marks it while something is loaded, and unmarks it when it goes", () => {
        media.hasMedia = true;
        root = createRoot(document.body.appendChild(document.createElement("div")));
        act(() => root!.render(<MiniPlayer />));
        expect(marked()).toBe(true);
        act(() => root!.unmount());
        root = null;
        expect(marked()).toBe(false);
    });

    it("does not mark it with nothing loaded", () => {
        media.hasMedia = false;
        root = createRoot(document.body.appendChild(document.createElement("div")));
        act(() => root!.render(<MiniPlayer />));
        expect(marked()).toBe(false);
    });
});

const ROOT = path.resolve(__dirname, "..", "..");
function sources(dir: string, pick: (name: string) => boolean): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "__tests__" ? [] : sources(full, pick);
        return pick(e.name) ? [full] : [];
    });
}
const pages = sources(path.join(ROOT, "app"), (n) => n === "page.tsx");
const markup = ["app", "features", "components"].flatMap((d) => sources(path.join(ROOT, d), (n) => n.endsWith(".tsx")));

describe("pages end with the layout's room", () => {
    it("nothing sets its own bottom padding of 96 px or more", () => {
        const own = markup
            .filter((f) => {
                const text = fs.readFileSync(f, "utf8");
                return /\bpb-(2[4-9]|[3-9]\d)\b/.test(text);
            })
            .map((f) => path.relative(ROOT, f));
        expect(own).toEqual([]);
    });

    it("every page that lists content ends with it", () => {
        // Full-height or standalone pages, a redirect, and settings (its layout ends it).
        const exempt = new Set(["stats", "vibe", "sync", "onboarding", "login", "share", "library", "settings"]);
        const missing = pages
            .filter((f) => !exempt.has(path.relative(path.join(ROOT, "app"), f).split(path.sep)[0]))
            .filter((f) => !fs.readFileSync(f, "utf8").includes("page-end"))
            .map((f) => path.relative(ROOT, f));
        expect(missing).toEqual([]);
    });

    it("the stylesheet defines the room and the class that uses it", () => {
        const css = fs.readFileSync(path.join(ROOT, "app", "globals.css"), "utf8");
        expect(css).toMatch(/--page-end:/);
        expect(css).toMatch(/\[data-mini-player\][^{]*\{[^}]*--page-end:/);
        expect(css).toMatch(/\.page-end\s*\{[^}]*padding-bottom:\s*var\(--page-end\)/);
    });
});
