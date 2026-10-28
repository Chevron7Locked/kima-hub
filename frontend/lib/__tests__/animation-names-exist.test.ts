/**
 * Every animation the source names exists: each `animate-*` class is a Tailwind built-in, an --animate-* token or a
 * class in the stylesheets, and each of those names a @keyframes; inline animations are not used at all. A name that points at nothing (the Soulseek
 * rows once named a fadeSlideIn that never existed) silently does not animate. Names are written out in full, never
 * built at run time, so this scan can see every one.
 */
import { it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const DIRS = ["app", "components", "features", "hooks", "lib"];
const BUILT_IN = new Set(["spin", "ping", "pulse", "bounce", "none"]);

function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : sources(full);
        return /\.(tsx?|css)$/.test(e.name) ? [full] : [];
    });
}

/** Source with its comments blanked, so a comment that mentions a pattern is not read as code. */
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const files = DIRS.flatMap((d) => sources(path.join(ROOT, d)));
const css = files.filter((f) => f.endsWith(".css")).map((f) => uncommented(fs.readFileSync(f, "utf8"))).join("\n");
const code = files.filter((f) => !f.endsWith(".css")).map((f) => [f, uncommented(fs.readFileSync(f, "utf8"))] as const);
const keyframes = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
const animateTokens = new Set([...css.matchAll(/--animate-([\w-]+)\s*:/g)].map((m) => m[1]));
const animateClasses = new Set([...css.matchAll(/\.animate-([\w-]+)\s*[{,:]/g)].map((m) => m[1]));

it("reads the stylesheets and the source", () => {
    expect(keyframes.size).toBeGreaterThan(5);
    expect(code.length).toBeGreaterThan(100);
});

it("every animate-* class is defined, and written out in full", () => {
    // Anything but a letter after "animate-" (a template slot, a quote before a joined string) is a name this scan
    // cannot read, so it fails as surely as a name that points at nothing.
    const missing = code.flatMap(([file, text]) =>
        [...text.matchAll(/(?<![\w-])animate-([a-z][a-z-]*)?/g)]
            .map((m) => m[1] ?? "")
            .filter((n) => !n || (!BUILT_IN.has(n) && !animateTokens.has(n) && !animateClasses.has(n)))
            .map((n) => `${path.relative(ROOT, file)}: animate-${n || "<built at run time>"}`),
    );
    expect(missing).toEqual([]);
});

it("no inline animation: every animation is an animate-* class, where the check above can see it", () => {
    // Inline animationDelay and the like are fine; the animation itself lives in globals.css.
    const inline = code.flatMap(([file, text]) =>
        [...text.matchAll(/\banimation(?:Name)?\s*:\s*[`"'$]/g)].map((m) => `${path.relative(ROOT, file)}: ${m[0]}`),
    );
    expect(inline).toEqual([]);
});

it("every --animate-* token and .animate-* class names a keyframe that exists", () => {
    const named = [
        ...[...css.matchAll(/--animate-([\w-]+)\s*:\s*([\w-]+)/g)].map((m) => [`--animate-${m[1]}`, m[2]]),
        ...[...css.matchAll(/\.animate-([\w-]+)\s*\{[^}]*?\banimation(?:-name)?\s*:\s*([\w-]+)/g)].map((m) => [`.animate-${m[1]}`, m[2]]),
    ];
    expect(named.length).toBeGreaterThan(5);
    // A class may point at a token (animation: var(--animate-x)), which the token's own entry covers.
    expect(named.filter(([, kf]) => kf !== "var" && !keyframes.has(kf))).toEqual([]);
});
