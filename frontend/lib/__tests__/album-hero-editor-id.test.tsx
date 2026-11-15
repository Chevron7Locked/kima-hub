/**
 * The album header hands the editor the album's own MusicBrainz release-group id (`rgMbid`, which the album reply
 * carries), so the editor's id field shows it and a save that does not touch it sends nothing for it.
 */
import { afterEach, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React, { act } from "react";

const seen = vi.hoisted(() => ({ props: null as null | { currentData: Record<string, unknown> } }));
vi.mock("@/components/MetadataEditControls", () => ({
    MetadataEditControls: (props: { currentData: Record<string, unknown> }) => {
        seen.props = props;
        return null;
    },
}));

import { AlbumHero } from "@/features/album/components/AlbumHero";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement;

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    seen.props = null;
});

it("passes the album's rgMbid to the editor", () => {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() =>
        root!.render(
            <AlbumHero
                album={{ id: "x", title: "Thriller", rgMbid: "11111111-1111-4111-8111-111111111111", artist: { id: "mj", name: "Michael Jackson" } } as never}
                source="library"
                coverUrl={null}
                colors={null}
                onReload={() => {}}
            />,
        ),
    );

    expect(seen.props?.currentData.rgMbid).toBe("11111111-1111-4111-8111-111111111111");
    expect(seen.props?.currentData).not.toHaveProperty("mbid");
});
