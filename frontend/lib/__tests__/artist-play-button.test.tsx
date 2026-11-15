/**
 * The artist page's big play button belongs to one artist by id. Two artists can share a name; a song by the other one
 * (or a song of this artist that was started from elsewhere) does not make this page's artist current. The real page
 * and action bar, with the data, the audio providers and the heavy sections stood in for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { mountHost } from "./helpers/dom";

const audio = {
    isPlaying: false,
    currentTrack: null as { id: string; artist?: { id?: string; name: string } } | null,
    queueSource: null as string | null,
    pause: vi.fn(),
    resumeWithGesture: vi.fn(async () => undefined),
};
const playAll = vi.fn();

vi.mock("@/lib/audio-state-context", () => ({
    useAudioState: () => ({ currentTrack: audio.currentTrack, currentQueueSource: audio.queueSource }),
}));
vi.mock("@/lib/audio-playback-context", () => ({ useAudioPlayback: () => ({ isPlaying: audio.isPlaying }) }));
vi.mock("@/lib/audio-controls-context", () => ({
    useAudioControls: () => ({
        pause: audio.pause,
        resumeWithGesture: audio.resumeWithGesture,
        playTracks: vi.fn(),
        playStation: vi.fn(),
    }),
}));
vi.mock("@/lib/download-context", () => ({ useDownloadContext: () => ({ isPendingByMbid: () => false }) }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "user" } }) }));
vi.mock("@/hooks/useQueries", () => ({ usePublicConfig: () => ({ canAcquire: false }) }));
vi.mock("@/hooks/useImageColor", () => ({ useImageColor: () => ({ colors: null }) }));
vi.mock("@/hooks/usePreview", () => ({ usePreview: () => ({ previewId: null, playing: false, toggle: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api: { getCoverArtUrl: (id: string) => `/cover/${id}` } }));
vi.mock("@/features/artist/hooks/useArtistData", () => ({
    useArtistData: () => ({
        artist: { id: "ar-1", name: "Same Name", topTracks: [] },
        albums: [],
        loading: false,
        error: false,
        source: "library",
        sortBy: "year",
        setSortBy: vi.fn(),
        reloadArtist: vi.fn(),
    }),
}));
vi.mock("@/features/artist/hooks/useArtistActions", () => ({
    useArtistActions: () => ({ playAll, shufflePlay: vi.fn() }),
}));
vi.mock("@/features/artist/hooks/useDownloadActions", () => ({
    useDownloadActions: () => ({ downloadArtist: vi.fn(), downloadAlbum: vi.fn() }),
}));
vi.mock("next/link", () => ({
    default: ({ children, href }: { children?: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
for (const path of [
    "ArtistHero",
    "ArtistBio",
    "PopularTracks",
    "Discography",
    "AvailableAlbums",
    "SimilarArtists",
]) {
    vi.doMock(`@/features/artist/components/${path}`, () => ({
        [path]: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    }));
}
vi.mock("@/features/library/components/DeleteLibraryItemDialog", () => ({ DeleteLibraryItemDialog: () => null }));

const dom = mountHost();

beforeEach(() => {
    audio.isPlaying = false;
    audio.currentTrack = null;
    audio.queueSource = null;
    audio.pause.mockClear();
    audio.resumeWithGesture.mockClear();
    playAll.mockClear();
});

async function mountPage() {
    const { default: ArtistPage } = await import("@/app/artist/[id]/page");
    act(() => dom.root.render(<ArtistPage />));
}
const disc = () => dom.host.querySelector<HTMLButtonElement>("button")!;
const press = () => act(async () => disc().click());

describe("the artist page's big play button", () => {
    it("starts this artist, and does not pause, when another artist with the same name is playing", async () => {
        audio.currentTrack = { id: "t", artist: { id: "ar-2", name: "Same Name" } };
        audio.isPlaying = true;
        audio.queueSource = "artist:ar-2";
        await mountPage();
        expect(disc().getAttribute("aria-label")).toMatch(/play/i);

        await press();

        expect(audio.pause).not.toHaveBeenCalled();
        expect(playAll).toHaveBeenCalledTimes(1);
    });

    it("starts this artist, and does not resume, when a paused song of theirs was started from another list", async () => {
        audio.currentTrack = { id: "t", artist: { id: "ar-1", name: "Same Name" } };
        audio.queueSource = "playlist:p-1";
        await mountPage();

        await press();

        expect(audio.resumeWithGesture).not.toHaveBeenCalled();
        expect(playAll).toHaveBeenCalledTimes(1);
    });

    it("pauses this artist while the queue that came from this page sounds", async () => {
        audio.currentTrack = { id: "t", artist: { id: "ar-1", name: "Same Name" } };
        audio.isPlaying = true;
        audio.queueSource = "artist:ar-1";
        await mountPage();

        await press();

        expect(audio.pause).toHaveBeenCalledTimes(1);
        expect(playAll).not.toHaveBeenCalled();
    });
});
