/**
 * The big play button on an album, an artist, a mix and a Discover playlist. When what is playing belongs to the thing
 * on the page it pauses what sounds and resumes what is paused, from the same point; otherwise it starts it. The
 * loaded queue's source says which: a paused song of this album that was started from somewhere else (a playlist,
 * say) does not make the album current. The action bars and pages are the real components with the audio providers
 * stood in for, so a press shows whether the start callback (a restart) or `pause`/`resume` ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const audio = {
    isPlaying: false,
    currentTrack: null as { id: string } | null,
    /** Where the loaded queue came from, as the audio state reports it. */
    queueSource: null as string | null,
    pause: vi.fn(),
    resumeWithGesture: vi.fn(async () => undefined),
    playTracks: vi.fn(),
};

vi.mock("@/lib/audio-state-context", () => ({ useAudioState: () => ({ currentTrack: audio.currentTrack, currentQueueSource: audio.queueSource }) }));
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
vi.mock("@/components/ui/CachedImage", () => ({ CachedImage: () => null }));
vi.mock("@/features/library/components/LibraryGrid", () => ({ LibraryListStatus: () => null }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "mix-1" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/notify", () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
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
vi.mock("@/hooks/useDoubleTap", () => ({
    useDoubleTap: (callback: () => void) => ({ onTouchEnd: () => {}, onDoubleClick: callback }),
    useDoubleTapList: () => () => {},
}));
vi.mock("next/link", () => ({
    default: ({ children, href }: { children?: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/cards/MediaCard", () => ({ CoverArt: () => null }));

import { AlbumActionBar } from "@/features/album/components/AlbumActionBar";
import { ArtistActionBar } from "@/features/artist/components/ArtistActionBar";
import { DiscoverActionBar } from "@/features/discover/components/DiscoverActionBar";
import MixPage from "@/app/mix/[id]/page";

const dom = mountHost();

beforeEach(() => {
    audio.isPlaying = false;
    audio.currentTrack = null;
    audio.queueSource = null;
    audio.pause.mockClear();
    audio.resumeWithGesture.mockClear();
    audio.playTracks.mockClear();
});

/** The big disc is the first button of every bar and page. */
const disc = () => dom.host.querySelector<HTMLButtonElement>("button")!;
const press = () => act(async () => disc().click());

/** What the disc does in each state. `mount()` renders the thing; `source` is the queue source that means "this one". */
function behaves(source: string, mount: () => void, started: () => number) {
    it("pauses what sounds when it is the one on the page, and does not start it again", async () => {
        audio.currentTrack = { id: "a" };
        audio.isPlaying = true;
        audio.queueSource = source;
        mount();
        expect(disc().getAttribute("aria-label")).toMatch(/pause/i);

        await press();

        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(started()).toBe(0);
    });

    it("resumes what is paused when it is the one on the page, and does not start it again", async () => {
        audio.currentTrack = { id: "a" };
        audio.isPlaying = false;
        audio.queueSource = source;
        mount();
        expect(disc().getAttribute("aria-label")).toMatch(/play/i);

        await press();

        expect(audio.resumeWithGesture).toHaveBeenCalledTimes(1);
        expect(audio.pause).not.toHaveBeenCalled();
        expect(started()).toBe(0);
    });

    it("starts it when something else is playing", async () => {
        audio.currentTrack = { id: "z" };
        audio.isPlaying = true;
        audio.queueSource = "playlist:other";
        mount();

        await press();

        expect(audio.pause).not.toHaveBeenCalled();
        expect(started()).toBe(1);
    });

    it("starts it, and does not resume, when its own song is paused but the queue came from somewhere else", async () => {
        audio.currentTrack = { id: "a" };
        audio.isPlaying = false;
        audio.queueSource = "playlist:other";
        mount();

        await press();

        expect(audio.resumeWithGesture).not.toHaveBeenCalled();
        expect(started()).toBe(1);
    });

    it("starts it, and does not pause, when its own song sounds but the queue came from somewhere else", async () => {
        audio.currentTrack = { id: "a" };
        audio.isPlaying = true;
        audio.queueSource = "playlist:other";
        mount();
        expect(disc().getAttribute("aria-label")).toMatch(/play/i);

        await press();

        expect(audio.pause).not.toHaveBeenCalled();
        expect(started()).toBe(1);
    });

    it("starts it when nothing is playing", async () => {
        mount();

        await press();

        expect(audio.resumeWithGesture).not.toHaveBeenCalled();
        expect(started()).toBe(1);
    });
}

describe("an album's big play button", () => {
    const onPlayAll = vi.fn();
    beforeEach(() => onPlayAll.mockClear());
    behaves(
        "album:al",
        () =>
            act(() =>
                dom.root.render(
                    <AlbumActionBar
                        album={{ id: "al", title: "Album", owned: true } as never}
                        source="library"
                        onPlayAll={onPlayAll}
                        onShuffle={() => {}}
                        onAddToPlaylist={() => {}}
                        isPendingDownload={false}
                    />,
                ),
            ),
        () => onPlayAll.mock.calls.length,
    );
});

describe("an artist's big play button", () => {
    const onPlayAll = vi.fn();
    beforeEach(() => onPlayAll.mockClear());
    behaves(
        "artist:ar",
        () =>
            act(() =>
                dom.root.render(
                    <ArtistActionBar
                        artistId="ar"
                        albums={[]}
                        source="library"
                        onPlayAll={onPlayAll}
                        onShuffle={() => {}}
                        onStartRadio={() => {}}
                        isPendingDownload={false}
                    />,
                ),
            ),
        () => onPlayAll.mock.calls.length,
    );
});

describe("a mix's big play button", () => {
    behaves(
        "mix:mix-1",
        () => act(() => dom.root.render(<MixPage />)),
        () => audio.playTracks.mock.calls.length,
    );
});

describe("the Discover playlist's big play button", () => {
    const onPlayAll = vi.fn();
    beforeEach(() => onPlayAll.mockClear());
    behaves(
        "discover",
        () =>
            act(() =>
                dom.root.render(
                    <DiscoverActionBar
                        playlist={{ tracks: [{ id: "a" }] } as never}
                        onPlayAll={onPlayAll}
                        isGenerating={false}
                    />,
                ),
            ),
        () => onPlayAll.mock.calls.length,
    );
});
