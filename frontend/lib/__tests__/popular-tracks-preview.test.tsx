/**
 * #228: the Popular list on an artist page previews songs the library does not have. On a touch screen, with no hover,
 * a preview playing must still show: the row pulses as it does for a library song, its number-tap says it stops the
 * preview, and the number turns into a play icon only on screens that can hover (never stuck on a tap).
 */
import { describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: (id: string) => `/cover/${id}` } }));
vi.mock("@/hooks/useDoubleTap", () => ({ useDoubleTapList: () => () => {} }));

import { PopularTracks } from "@/features/artist/components/PopularTracks";

const dom = mountHost();
const artist = { id: "ar1", name: "Some Artist" } as never;
const unowned = { id: "t1", title: "Hidden Song", duration: 200, album: { title: "Unknown Album" } } as never;
const owned = { id: "t2", title: "Owned Song", duration: 200, album: { id: "al1", title: "Real Album", coverArt: "c" } } as never;

function render(previewTrack: string | null, previewPlaying: boolean) {
    act(() =>
        dom.root.render(
            <PopularTracks
                tracks={[unowned, owned]}
                artist={artist}
                currentTrackId={undefined}
                onPlayTrack={() => {}}
                previewTrack={previewTrack}
                previewPlaying={previewPlaying}
                onPreview={() => {}}
            />,
        ),
    );
}
const rows = () => [...dom.host.querySelectorAll("[data-track-row]")];

describe("Popular previews on a touch screen (#228)", () => {
    it("shows a preview playing: the row pulses and its number-tap stops it", () => {
        render("t1", true);
        const row = rows()[0];
        expect(row.querySelector(".animate-pulse")).not.toBeNull();
        expect(row.querySelector('button[aria-label^="Pause"]')).not.toBeNull();
        // The other row is not marked.
        expect(rows()[1].querySelector(".animate-pulse")).toBeNull();
    });

    it("shows nothing playing when the preview is paused", () => {
        render("t1", false);
        expect(rows()[0].querySelector(".animate-pulse")).toBeNull();
    });

    it("swaps the number for a play icon only where the screen can hover", () => {
        render(null, false);
        const play = rows()[0].querySelector("button[aria-label^='Play']")!;
        const [number, icon] = [play.querySelector("span")!, play.querySelector("svg")!];
        expect(number.className).toContain("can-hover:group-hover:hidden");
        expect(number.className).not.toMatch(/(^|\s)group-hover:hidden/);
        expect(icon.getAttribute("class")).toContain("can-hover:group-hover:block");
    });
});
