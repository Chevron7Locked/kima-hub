/**
 * A count of zero hides its part of a header's meta line: an artist with 0 listeners and an album with 0 songs show
 * no stray "0" (React prints a 0 used as a condition).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

vi.mock("@/components/MetadataEditControls", () => ({ MetadataEditControls: () => null }));

import { ArtistHero } from "@/features/artist/components/ArtistHero";
import { AlbumHero } from "@/features/album/components/AlbumHero";
import type { Album, Artist } from "@/features/artist/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement;

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
});

function draw(node: React.ReactNode) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() => root!.render(node));
    return container.textContent ?? "";
}

describe("header meta lines", () => {
    it("an artist with no listeners shows only the album count", () => {
        const albums = Array.from({ length: 14 }, (_, i) => ({ id: `a${i}`, title: `a${i}`, owned: false }) as unknown as Album);
        const text = draw(
            <ArtistHero
                artist={{ id: "mj", name: "Michael Jackson", listeners: 0 } as unknown as Artist}
                source="discovery"
                albums={albums}
                heroImage={null}
                colors={null}
                onReload={() => {}}
            />,
        );
        expect(text).toContain("14 albums");
        expect(text.replace("14 albums", "")).not.toContain("0");
    });

    it("an album with no songs counted and no year shows no 0", () => {
        const text = draw(
            <AlbumHero
                album={{ id: "x", title: "Thriller", trackCount: 0, year: 0, artist: { id: "mj", name: "Michael Jackson" } } as never}
                source="discovery"
                coverUrl={null}
                colors={null}
                onReload={() => {}}
            />,
        );
        expect(text).toContain("Thriller");
        expect(text).not.toContain("0");
    });
});
