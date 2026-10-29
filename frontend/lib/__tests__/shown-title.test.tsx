// The player shows a song's edited title, like the song lists do: the bar, the full player and the lock screen read
// it through useMediaInfo and shownTitle.
import { describe, it, expect, vi } from "vitest";
import { createRoot } from "react-dom/client";
import React, { act } from "react";
import { shownTitle } from "@/lib/track-title";

const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/lib/audio-context", () => ({ useAudioState: () => state.value }));
vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: (id: string) => `/cover/${id}` } }));

import { useMediaInfo } from "@/hooks/useMediaInfo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function titleShown(track: Record<string, unknown>): string {
    state.value = { currentTrack: track, currentAudiobook: null, currentPodcast: null, playbackType: "track" };
    let seen = "";
    function Probe() {
        seen = useMediaInfo().title;
        return null;
    }
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    act(() => root.render(<Probe />));
    act(() => root.unmount());
    container.remove();
    return seen;
}

describe("a song's shown title", () => {
    it("is the edited title when there is one, else the file's", () => {
        expect(shownTitle({ title: "file", displayTitle: "edited" })).toBe("edited");
        expect(shownTitle({ title: "file", displayTitle: null })).toBe("file");
        expect(shownTitle({ title: "file", displayTitle: "" })).toBe("file");
        expect(shownTitle({ title: "file" })).toBe("file");
    });

    it("is what the player shows for the playing song", () => {
        const track = { id: "t1", title: "file", displayTitle: "edited", artist: { name: "a" }, album: { title: "b" } };
        expect(titleShown(track)).toBe("edited");
        expect(titleShown({ ...track, displayTitle: null })).toBe("file");
    });
});
