/**
 * The play button on a song row. On the row that is current it pauses what is sounding and resumes what is paused,
 * from the same point; on any other row it starts the list from there. The lists are the real components with the
 * audio providers stood in for, so a press shows whether `playTracks` (a restart) or `pause`/`resume` ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const audio = {
    isPlaying: false,
    currentTrack: null as { id: string } | null,
    pause: vi.fn(),
    resumeWithGesture: vi.fn(async () => undefined),
    playTracks: vi.fn(),
};

vi.mock("@/lib/audio-state-context", () => ({ useAudioState: () => ({ currentTrack: audio.currentTrack }) }));
vi.mock("@/lib/audio-playback-context", () => ({ useAudioPlayback: () => ({ isPlaying: audio.isPlaying }) }));
vi.mock("@/lib/audio-controls-context", () => ({
    useAudioControls: () => ({
        pause: audio.pause,
        resumeWithGesture: audio.resumeWithGesture,
        playTracks: audio.playTracks,
        addToQueue: vi.fn(),
    }),
}));
vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: (id: string) => `/cover/${id}` } }));
vi.mock("@/hooks/useDoubleTap", () => ({
    useDoubleTap: (callback: () => void) => ({ onTouchEnd: () => {}, onDoubleClick: callback }),
    useDoubleTapList: () => () => {},
}));
vi.mock("@/components/ui/CachedImage", () => ({ CachedImage: () => null }));
vi.mock("@/components/ui/PlaylistSelector", () => ({ PlaylistSelector: () => null }));
vi.mock("@/features/library/components/LibraryGrid", () => ({ LibraryListStatus: () => null }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "mix-1" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
    default: ({ children, href }: { children?: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/notify", () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/useQueries", () => ({
    useMixQuery: () => ({
        data: {
            id: "mix-1",
            name: "Mix",
            tracks: ["a", "b"].map((id) => ({
                id,
                title: `Song ${id}`,
                duration: 100,
                albumId: "al",
                album: { title: "Album", artist: { id: "ar", name: "Artist" } },
            })),
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
    }),
}));
vi.mock("@/components/cards/MediaCard", () => ({ CoverArt: () => null }));

import { TracksList } from "@/features/library/components/TracksList";
import { TrackList as AlbumTrackList } from "@/features/album/components/TrackList";
import { PopularTracks } from "@/features/artist/components/PopularTracks";
import { TrackList as DiscoverTrackList } from "@/features/discover/components/TrackList";
import MixPage from "@/app/mix/[id]/page";
import { LibraryTracksList } from "@/features/search/components/LibraryTracksList";

const dom = mountHost();

beforeEach(() => {
    audio.isPlaying = false;
    audio.currentTrack = null;
    audio.pause.mockClear();
    audio.resumeWithGesture.mockClear();
    audio.playTracks.mockClear();
});

/** The rows of whichever list is shown: each marks them with data-track-index or, in the library list, data-tv-card. */
const rows = () => [...dom.host.querySelectorAll<HTMLElement>("[data-track-index], [data-tv-card]")];
const button = (place: number) => rows()[place].querySelector<HTMLButtonElement>("button")!;
const press = (place: number) => act(async () => button(place).click());

/** What each list does when its first button is pressed on a row, in the state the test set up. */
function behaves(mount: () => void, started: () => number) {
    it("pauses the current song while it sounds, and does not start the list again", async () => {
        audio.currentTrack = { id: "b" };
        audio.isPlaying = true;
        mount();
        expect(button(1).getAttribute("aria-label")).toMatch(/^pause/);

        await press(1);

        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(started()).toBe(0);
    });

    it("resumes the current song when it is paused, and does not start the list again", async () => {
        audio.currentTrack = { id: "b" };
        audio.isPlaying = false;
        mount();
        expect(button(1).getAttribute("aria-label")).toMatch(/^play/);

        await press(1);

        expect(audio.resumeWithGesture).toHaveBeenCalledTimes(1);
        expect(audio.pause).not.toHaveBeenCalled();
        expect(started()).toBe(0);
    });

    it("never pauses on a double click of the current song, and resumes it when paused", async () => {
        audio.currentTrack = { id: "b" };
        audio.isPlaying = true;
        mount();
        await act(async () => rows()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
        expect(audio.pause).not.toHaveBeenCalled();
        expect(started()).toBe(0);

        audio.isPlaying = false;
        mount();
        await act(async () => rows()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
        expect(audio.resumeWithGesture).toHaveBeenCalledTimes(1);
        expect(started()).toBe(0);
    });

    it("starts the list on a double click of another row", async () => {
        audio.currentTrack = { id: "b" };
        audio.isPlaying = true;
        mount();
        await act(async () => rows()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
        expect(started()).toBe(1);
    });

    it("shows the pause icon on the song that sounds, and the play icon on a paused or other one", async () => {
        const icons = (place: number) => ({
            pause: button(place).querySelector(".lucide-pause") !== null,
            play: button(place).querySelector(".lucide-play") !== null,
        });
        audio.currentTrack = { id: "b" };
        audio.isPlaying = true;
        mount();
        expect(icons(1)).toEqual({ pause: true, play: false });
        expect(icons(0)).toEqual({ pause: false, play: true });

        audio.isPlaying = false;
        mount();
        expect(icons(1)).toEqual({ pause: false, play: true });
    });

    it("starts the list from another row, as before", async () => {
        audio.currentTrack = { id: "b" };
        audio.isPlaying = true;
        mount();

        await press(0);

        expect(audio.pause).not.toHaveBeenCalled();
        expect(started()).toBe(1);
    });
}

describe("the library songs list", () => {
    const onPlay = vi.fn();
    beforeEach(() => onPlay.mockClear());
    const song = (id: string) => ({ id, title: id, duration: 100, album: { id: "al", title: "Album", artist: { name: "x" } } });
    behaves(
        () => {
            act(() =>
                dom.root.render(
                    <TracksList
                        tracks={[song("a"), song("b")] as never}
                        onPlay={onPlay}
                        onAddToQueue={() => {}}
                    />,
                ),
            );
        },
        () => onPlay.mock.calls.length,
    );
});

describe("an album's song list", () => {
    const onPlayTrack = vi.fn();
    beforeEach(() => onPlayTrack.mockClear());
    const song = (id: string, n: number) => ({ id, title: id, duration: 100, trackNumber: n, discNumber: null, isMissing: false });
    behaves(
        () => {
            act(() =>
                dom.root.render(
                    <AlbumTrackList
                        tracks={[song("a", 1), song("b", 2)] as never}
                        album={{ id: "al", title: "Album", artist: { name: "x" } } as never}
                        source="library"
                        currentTrackId={audio.currentTrack?.id}
                        colors={null}
                        onPlayTrack={onPlayTrack}
                        onAddToQueue={() => {}}
                        onAddToPlaylist={() => {}}
                        previewTrack={null}
                        previewPlaying={false}
                        onPreview={() => {}}
                    />,
                ),
            );
        },
        () => onPlayTrack.mock.calls.length,
    );
});

describe("an artist's popular songs", () => {
    const onPlayTrack = vi.fn();
    beforeEach(() => onPlayTrack.mockClear());
    const song = (id: string) => ({ id, title: id, duration: 100, album: { id: "al", title: "Album", coverArt: "c" } });
    behaves(
        () => {
            act(() =>
                dom.root.render(
                    <PopularTracks
                        tracks={[song("a"), song("b")] as never}
                        artist={{ id: "ar", name: "Artist" } as never}
                        currentTrackId={audio.currentTrack?.id}
                        onPlayTrack={onPlayTrack}
                        previewTrack={null}
                        previewPlaying={false}
                        onPreview={() => {}}
                    />,
                ),
            );
        },
        () => onPlayTrack.mock.calls.length,
    );
});

describe("a mix's song list", () => {
    behaves(
        () => act(() => dom.root.render(<MixPage />)),
        () => audio.playTracks.mock.calls.length,
    );
});

describe("the Discover playlist's song list", () => {
    const onPlayTrack = vi.fn();
    beforeEach(() => onPlayTrack.mockClear());
    const song = (id: string) => ({
        id,
        title: id,
        artist: "Artist",
        album: "Album",
        albumId: `al-${id}`,
        coverUrl: null,
        duration: 100,
        tier: "high",
        isLiked: false,
    });
    behaves(
        () => {
            act(() =>
                dom.root.render(
                    <DiscoverTrackList
                        tracks={[song("a"), song("b")] as never}
                        currentTrack={audio.currentTrack}
                        onPlayTrack={onPlayTrack}
                        onLike={() => {}}
                    />,
                ),
            );
        },
        () => onPlayTrack.mock.calls.length,
    );
});

describe("the search page's library songs", () => {
    const song = (id: string) => ({ id, title: id, duration: 100, album: { id: "al", title: "Album", coverUrl: null, artist: { id: "ar", name: "Artist" } } });
    const mount = () => act(() => dom.root.render(<LibraryTracksList tracks={[song("a"), song("b")] as never} />));
    const first = (place: number) => dom.host.querySelectorAll<HTMLButtonElement>(".group > button")[place];

    it("pauses the current song while it sounds, resumes it when paused, and starts the list from another row", async () => {
        audio.currentTrack = { id: "b" };
        audio.isPlaying = true;
        mount();
        await act(async () => first(1).click());
        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(audio.playTracks).not.toHaveBeenCalled();

        audio.isPlaying = false;
        mount();
        await act(async () => first(1).click());
        expect(audio.resumeWithGesture).toHaveBeenCalledTimes(1);
        expect(audio.playTracks).not.toHaveBeenCalled();

        await act(async () => first(0).click());
        expect(audio.playTracks).toHaveBeenCalledTimes(1);
    });
});
