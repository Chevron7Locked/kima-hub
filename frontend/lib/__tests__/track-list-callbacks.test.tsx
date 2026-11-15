/**
 * The rows of the album's song list and the library's song list are memoised, so a row only draws again when what it
 * shows changes. A press on a row still has to run the list's latest play callback, and with the list as it is now:
 * after the list is replaced or reordered, never the one the row last drew with.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const audio = { isPlaying: false, currentTrack: null as { id: string } | null };
vi.mock("@/lib/audio-state-context", () => ({
    useAudioState: () => ({ currentTrack: audio.currentTrack, currentQueueSource: null }),
}));
vi.mock("@/lib/audio-playback-context", () => ({ useAudioPlayback: () => ({ isPlaying: audio.isPlaying }) }));
vi.mock("@/lib/audio-controls-context", () => ({
    useAudioControls: () => ({ pause: vi.fn(), resumeWithGesture: vi.fn(async () => undefined) }),
}));
vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: (id: string) => `/cover/${id}` } }));
vi.mock("@/components/ui/CachedImage", () => ({ CachedImage: () => null }));
vi.mock("@/components/ui/PlaylistSelector", () => ({ PlaylistSelector: () => null }));
vi.mock("@/features/library/components/LibraryGrid", () => ({ LibraryListStatus: () => null }));
vi.mock("@/hooks/useDoubleTap", () => ({
    useDoubleTap: (callback: () => void) => ({ onTouchEnd: () => {}, onDoubleClick: callback }),
    useDoubleTapList: () => () => {},
}));

import { TrackList as AlbumTrackList } from "@/features/album/components/TrackList";
import { TracksList as LibraryTracksList } from "@/features/library/components/TracksList";

const dom = mountHost();

beforeEach(() => {
    audio.isPlaying = false;
    audio.currentTrack = null;
});

const albumTrack = (id: string) => ({ id, title: `Song ${id}`, duration: 100, trackNumber: 1 });
const libraryTrack = (id: string) => ({
    id,
    title: `Song ${id}`,
    duration: 100,
    album: { id: "al", title: "Album", artist: { id: "ar", name: "Artist" } },
});

/** The play button of the row at this place. */
const playButton = (place: number) =>
    dom.host.querySelectorAll<HTMLElement>("[data-track-index], [data-tv-card-index]")[place].querySelector("button")!;

describe("the album's song list", () => {
    const render = (tracks: string[], onPlayTrack: (t: { id: string }, i: number) => void) =>
        act(() =>
            dom.root.render(
                <AlbumTrackList
                    tracks={tracks.map(albumTrack) as never}
                    album={{ id: "al", title: "Album", artist: { name: "Artist" } } as never}
                    source="library"
                    currentTrackId={undefined}
                    colors={null}
                    onPlayTrack={onPlayTrack as never}
                    onAddToQueue={() => {}}
                    onAddToPlaylist={() => {}}
                    previewTrack={null}
                    previewPlaying={false}
                    onPreview={() => {}}
                />,
            ),
        );

    it("calls the latest play callback when the list is given a new one and nothing else changes", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render(["a", "b"], first);
        render(["a", "b"], second);

        await act(async () => playButton(1).click());

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        expect(second.mock.calls[0][0]).toMatchObject({ id: "b" });
        expect(second.mock.calls[0][1]).toBe(1);
    });

    it("plays the song and place the row has now after the list is reordered", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render(["a", "b", "c"], first);
        render(["c", "b", "a"], second);

        await act(async () => playButton(0).click());

        expect(first).not.toHaveBeenCalled();
        expect(second.mock.calls[0][0]).toMatchObject({ id: "c" });
        expect(second.mock.calls[0][1]).toBe(0);
    });
});

describe("the library's song list", () => {
    const render = (tracks: string[], onPlay: (tracks: unknown[], startIndex?: number) => void) =>
        act(() =>
            dom.root.render(
                <LibraryTracksList tracks={tracks.map(libraryTrack) as never} onPlay={onPlay} onAddToQueue={() => {}} />,
            ),
        );

    it("plays the list as it is now, through the latest callback, when the list is replaced with the same songs", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render(["a", "b"], first);
        render(["a", "b"], second);

        await act(async () => playButton(1).click());

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        expect(second.mock.calls[0][1]).toBe(1);
    });

    it("plays the reordered list from the place the row has now", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render(["a", "b", "c"], first);
        render(["c", "b", "a"], second);

        await act(async () => playButton(0).click());

        expect(first).not.toHaveBeenCalled();
        const [queue, start] = second.mock.calls[0];
        expect((queue as { id: string }[]).map((t) => t.id)).toEqual(["c", "b", "a"]);
        expect(start).toBe(0);
    });
});
