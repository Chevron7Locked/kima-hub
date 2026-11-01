/**
 * A cover from the library's resizing endpoint is offered at several widths, so a 2x or 3x screen gets a sharp
 * one instead of the 1x size stretched. Anything else (outside URLs, books and podcasts, or a fill image with no
 * `sizes` to choose by) is used as given.
 */
import { describe, it, expect, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CachedImage } from "@/components/ui/CachedImage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
});

function draw(el: React.ReactElement) {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(el));
    return host.querySelector("img")!;
}

const COVER = "/api/library/cover-art?url=native%3Aabc.jpg&size=200&token=t";

describe("cover sizes", () => {
    it("offers a library cover at several widths, each asked of the server by size", () => {
        const img = draw(<CachedImage src={COVER} alt="" fill sizes="200px" />);
        const widths = [...(img.getAttribute("srcset") ?? "").matchAll(/size=(\d+)&token=t (\d+)w/g)].map((m) => [m[1], m[2]]);
        expect(widths.length).toBeGreaterThan(3);
        // The server resizes up to 2048 px; a wider pick gets its largest.
        for (const [asked, offered] of widths) expect(Number(asked)).toBe(Math.min(Number(offered), 2048));
    });

    it("offers 1x and 2x for a fixed-width cover", () => {
        const img = draw(<CachedImage src={COVER} alt="" width={48} height={48} />);
        expect(img.getAttribute("srcset")).toMatch(/size=\d+&token=t 1x, .*size=\d+&token=t 2x/);
    });

    it("uses anything else as given", () => {
        for (const src of ["https://cdn-images.dzcdn.net/x.jpg", "/api/podcasts/p1/cover?token=t", COVER]) {
            const props = src === COVER ? { fill: true } : { fill: true, sizes: "200px" };
            const img = draw(<CachedImage src={src} alt="" {...props} />);
            expect(img.getAttribute("srcset")).toBeNull();
            expect(img.getAttribute("src")?.endsWith(src)).toBe(true);
            act(() => root!.unmount());
            root = null;
        }
    });
});
