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
    useCurrentMedia: () => ({ currentTrack: audio.currentTrack }),
    useQueueState: () => ({ currentQueueSource: null }),
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

describe("the album's song list, the other buttons of a row", () => {
    type Props = Partial<React.ComponentProps<typeof AlbumTrackList>>;
    const render = (props: Props, titles: Record<string, string> = {}) =>
        act(() =>
            dom.root.render(
                <AlbumTrackList
                    tracks={["a", "b"].map((id) => ({ ...albumTrack(id), title: titles[id] ?? `Song ${id}` })) as never}
                    album={{ id: "al", title: "Album", artist: { name: "Artist" } } as never}
                    source="library"
                    currentTrackId={undefined}
                    colors={null}
                    onPlayTrack={() => {}}
                    onAddToQueue={() => {}}
                    onAddToPlaylist={() => {}}
                    previewTrack={null}
                    previewPlaying={false}
                    onPreview={() => {}}
                    {...props}
                />,
            ),
        );
    const button = (label: string, place = 1) =>
        dom.host.querySelectorAll<HTMLElement>("[data-track-index]")[place].querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

    it("add to queue calls the latest callback", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render({ onAddToQueue: first });
        render({ onAddToQueue: second });
        await act(async () => button("add to queue").click());
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
        expect(second.mock.calls[0][0]).toMatchObject({ id: "b" });
    });

    it("add to playlist calls the latest callback", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render({ onAddToPlaylist: first });
        render({ onAddToPlaylist: second });
        await act(async () => button("add to playlist").click());
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith("b");
    });

    it("preview calls the latest callback", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render({ source: "discovery", onPreview: first });
        render({ source: "discovery", onPreview: second });
        await act(async () => button("play preview").click());
        expect(first).not.toHaveBeenCalled();
        expect(second.mock.calls[0][0]).toMatchObject({ id: "b" });
    });

    it("the playing row's edge takes the latest colours", async () => {
        render({ currentTrackId: "a", colors: { vibrant: "#111111" } as never });
        render({ currentTrackId: "a", colors: { vibrant: "#222222" } as never });
        const row = dom.host.querySelectorAll<HTMLElement>("[data-track-index]")[0];
        expect(row.style.borderLeftColor).toBe("#222222");
    });

    it("a song edited in place shows its new title and hands the new song to a callback", async () => {
        const play = vi.fn();
        render({ onPlayTrack: play });
        render({ onPlayTrack: play }, { b: "Song b, remastered" });
        expect(dom.host.textContent).toContain("Song b, remastered");
        await act(async () => playButton(1).click());
        expect(play.mock.calls[0][0]).toMatchObject({ title: "Song b, remastered" });
    });
});

describe("the library's song list, the other buttons of a row", () => {
    const render = (props: Partial<React.ComponentProps<typeof LibraryTracksList>>, titles: Record<string, string> = {}) =>
        act(() =>
            dom.root.render(
                <LibraryTracksList
                    tracks={["a", "b"].map((id) => ({ ...libraryTrack(id), title: titles[id] ?? `Song ${id}` })) as never}
                    onPlay={() => {}}
                    onAddToQueue={() => {}}
                    {...props}
                />,
            ),
        );
    const button = (title: string, place = 1) =>
        dom.host.querySelectorAll<HTMLElement>("[data-tv-card-index]")[place].querySelector<HTMLElement>(`[title="${title}"]`)!;

    it("add to queue calls the latest callback", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render({ onAddToQueue: first });
        render({ onAddToQueue: second });
        await act(async () => button("add to queue").click());
        expect(first).not.toHaveBeenCalled();
        expect(second.mock.calls[0][0]).toMatchObject({ id: "b" });
    });

    it("delete calls the latest callback, and appears and goes with it", async () => {
        const first = vi.fn();
        const second = vi.fn();
        render({ onDelete: first });
        render({ onDelete: second });
        await act(async () => button("delete track").click());
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith("b", "Song b");

        render({});
        expect(dom.host.querySelector('[title="delete track"]')).toBeNull();
        render({ onDelete: second });
        expect(dom.host.querySelector('[title="delete track"]')).not.toBeNull();
    });

    it("a song edited in place shows its new title and hands the new song to a callback", async () => {
        const add = vi.fn();
        render({ onAddToQueue: add });
        render({ onAddToQueue: add }, { b: "Song b, remastered" });
        expect(dom.host.textContent).toContain("Song b, remastered");
        await act(async () => button("add to queue").click());
        expect(add.mock.calls[0][0]).toMatchObject({ title: "Song b, remastered" });
    });
});
