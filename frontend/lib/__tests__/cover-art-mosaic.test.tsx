// A mix's or playlist's cover tile shows each different cover once and fits the tile to how many there are: one fills
// it, two sit side by side, three are one tall and two small, four make a 2x2 grid. It never repeats a cover to fill
// the tile, nor leaves an empty slot.
import { describe, it, expect, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";
import { Music } from "lucide-react";
import { CoverArt } from "@/components/cards/MediaCard";
import { mosaicCovers } from "@/features/playlist/coverMosaic";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement;

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
});

function draw(urls: string[]) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() => root!.render(<CoverArt imageUrl={urls} title="mix" sizes="200px" FallbackIcon={Music} />));
    // Next draws each image with an absolute address; the path is what was asked for.
    const srcs = [...container.querySelectorAll("img")].map((img) => new URL(img.getAttribute("src")!, "http://x").pathname);
    return { srcs, cells: container.querySelectorAll("[data-cover-cell]"), icons: container.querySelectorAll("svg"), tile: container.firstElementChild };
}

describe("the cover tile", () => {
    it("fills the tile with a single cover, and with a cover repeated", () => {
        for (const urls of [["/a.jpg"], ["/a.jpg", "/a.jpg", "/a.jpg", "/a.jpg"]]) {
            const { srcs, icons } = draw(urls);
            expect(srcs).toEqual(["/a.jpg"]);
            expect(icons.length).toBe(0);
            act(() => root!.unmount());
            root = null;
        }
    });

    it("puts two different covers side by side, each once", () => {
        const { srcs, cells, icons, tile } = draw(["/a.jpg", "/b.jpg", "/a.jpg", "/b.jpg"]);
        expect(srcs).toEqual(["/a.jpg", "/b.jpg"]);
        expect(cells.length).toBe(2);
        expect(tile?.getAttribute("data-cover-count")).toBe("2");
        expect(icons.length).toBe(0);
    });

    it("shows three different covers as one tall and two small", () => {
        const { srcs, cells, tile } = draw(["/a.jpg", "/b.jpg", "/c.jpg", "/a.jpg"]);
        expect(srcs).toEqual(["/a.jpg", "/b.jpg", "/c.jpg"]);
        expect(cells.length).toBe(3);
        expect(tile?.getAttribute("data-cover-count")).toBe("3");
        expect(cells[0].className).toContain("row-span-2");
    });

    it("makes a 2x2 grid of four different covers, and shows no more than four", () => {
        const { srcs, cells, tile } = draw(["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg", "/e.jpg"]);
        expect(srcs).toEqual(["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg"]);
        expect(cells.length).toBe(4);
        expect(tile?.getAttribute("data-cover-count")).toBe("4");
    });

    it("drops a cover that fails to load and refits, and shows the icon when every one fails", () => {
        const { srcs } = draw(["/a.jpg", "/b.jpg", "/c.jpg"]);
        expect(srcs).toHaveLength(3);
        const fire = () => act(() => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
        fire();
        expect(container.querySelectorAll("img")).toHaveLength(2);
        expect(container.firstElementChild?.getAttribute("data-cover-count")).toBe("2");
        fire();
        expect(container.querySelectorAll("img")).toHaveLength(1);
        fire();
        expect(container.querySelectorAll("img")).toHaveLength(0);
        expect(container.querySelectorAll("svg")).toHaveLength(1);
    });

    it("shows the fallback icon with no covers", () => {
        const { srcs, icons } = draw([]);
        expect(srcs).toEqual([]);
        expect(icons.length).toBe(1);
    });
});

describe("a playlist's mosaic covers", () => {
    it("lists each album's cover once, the albums with most songs first, at most four", () => {
        expect(mosaicCovers(["/b", "/a", "/a", null, "/b", "/a"])).toEqual(["/a", "/b"]);
        expect(mosaicCovers(["/c", "/a", "/a", "/b"])).toEqual(["/a", "/c", "/b"]);
        expect(mosaicCovers(["/a", "/b", "/c", "/d", "/e", "/e"])).toEqual(["/e", "/a", "/b", "/c"]);
    });
});
